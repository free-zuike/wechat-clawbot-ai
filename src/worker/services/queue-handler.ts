// Cloudflare Worker 队列处理器（从 index.ts 拆出）
// 处理图片/视频生成任务（image_generation / video_generation / video_check）

import { Logger } from "../utils/error";
import { parseApiUrl, buildVideoSubmitBody } from "./ai";

function detectImageMime(data: Uint8Array): string {
  if (data[0] === 0xFF && data[1] === 0xD8) return "image/jpeg";
  if (data[0] === 0x89 && data[1] === 0x50) return "image/png";
  if (data[0] === 0x52 && data[1] === 0x49) return "image/webp";
  return "image/png";
}

// 视频状态轮询：指数退避（30s→60s→120s→…→600s），最多 12 次（约 75 分钟）
// 免费档 RPM 很低（Agnes 20），固定 30s 轮询会持续烧额度并给限流封禁续命
const MAX_VIDEO_CHECK_ATTEMPTS = 12;
function videoCheckDelaySec(attempt: number): number {
  return Math.min(30 * Math.pow(2, attempt - 1), 600);
}

export async function handleQueueMessage(batch: MessageBatch<any>, env: any): Promise<void> {
  for (const msg of batch.messages) {
    const { type, prompt, model, provider, baseUrl, apiKey, source, allKeys, maxRetries, imageUrl: refImageUrl, imageUrls: refImageUrls, responseConfig: refResponseConfig } = msg.body;
    const isFromChat = source === "chat";
    Logger.info("[queue] Task received", { type, prompt: prompt?.slice(0, 50), model, provider, source });

    async function logGen(tp: string, pr: string, rs: string, pv: string, md: string, st: string, er?: string, src?: string) {
      try {
        const p = new URLSearchParams({ t: tp, p: pr.slice(0, 200), r: rs.slice(0, 200), pv, m: md, s: st, e: er || "", src: src || source || "" });
        const doStub = env.ILINK_CONNECTION.get(env.ILINK_CONNECTION.idFromName("main"));
        await doStub.fetch(new Request(`http://localhost/log-generation?${p}`));
      } catch (e: any) {
        console.error("[queue] logGen failed:", e?.message);
      }
    }

    try {
      if (type === "image_generation") {
        const { generateImage } = await import("./ai");
        const imageDataResult = await generateImage(env.AI, prompt, model, provider, baseUrl, apiKey, refImageUrl, undefined, allKeys, maxRetries, refImageUrls, refResponseConfig);
        const imageData = imageDataResult.data;
          if (imageData) {
            const dataLen = imageData instanceof Uint8Array ? imageData.length : (typeof imageData === "string" ? imageData.length : 0);
            if (dataLen === 0) {
              Logger.error("[queue] Image data is empty", { type: typeof imageData, constructor: imageData?.constructor?.name });
            } else {
              const doId = env.ILINK_CONNECTION.idFromName("main");
              const doStub = env.ILINK_CONNECTION.get(doId);
              let imageUrl: string;
              if (typeof imageData === "string") {
                imageUrl = imageData;
              } else {
                const arr = imageData instanceof Uint8Array ? imageData : new Uint8Array(imageData);
                let binary = "";
                for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
                const mime = detectImageMime(arr);
                imageUrl = `data:${mime};base64,${btoa(binary)}`;
              }
              Logger.info("[queue] Broadcasting image", { imageUrlLength: imageUrl.length, isDataUrl: imageUrl.startsWith("data:") });
              const broadcastResp = await doStub.fetch(new Request("http://localhost/broadcast-image", {
                method: "POST",
                body: JSON.stringify({ imageData: imageUrl, model, provider, source, keyIndex: imageDataResult.keyIndex, prompt }),
              }));
              if (!broadcastResp.ok) {
                const errText = await broadcastResp.text().catch(() => "unknown");
                Logger.error("[queue] Broadcast image failed", { status: broadcastResp.status, body: errText });
              }
              Logger.info("[queue] Image generated" + (isFromChat ? " (chat)" : " and broadcast"));
            }
          } else {
            Logger.error("[queue] Image generation returned null");
            const doId = env.ILINK_CONNECTION.idFromName("main");
            const doStub = env.ILINK_CONNECTION.get(doId);
            const errMsg = `图片生成失败 (${provider} · ${model})`;
            await doStub.fetch(new Request("http://localhost/broadcast-image", {
              method: "POST",
              body: JSON.stringify({ error: true, message: errMsg, model, provider, source, prompt }),
            }));
            // 如果有微信来源信息，也发送错误给用户
            if (isFromChat && msg.body.toUserId) {
              await doStub.fetch(new Request("http://localhost/send-text", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: `❌ ${errMsg}\n请稍后重试`, toUserId: msg.body.toUserId, contextToken: msg.body.contextToken, accountId: msg.body.accountId }),
              }));
            }
          }
      } else if (type === "video_generation") {
        const isCloudflare = !provider || provider === "cloudflare";
        // Cloudflare AI：直接使用 aiBinding
        if (isCloudflare && env.AI) {
          try {
            const { submitVideoTask } = await import("./ai");
            const result = await submitVideoTask(env.AI, prompt, model, provider, baseUrl, apiKey);
            if (result) {
              const doId = env.ILINK_CONNECTION.idFromName("main");
              const doStub = env.ILINK_CONNECTION.get(doId);
              await doStub.fetch(new Request("http://localhost/store-pending-video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ taskId: result.taskId, videoId: result.videoId, prompt: result.prompt, model: result.model, provider: result.provider, baseUrl: result.baseUrl, apiKey: result.apiKey, source }),
              }));
              if (result.url) {
                // 同步返回了视频 URL
                const broadcastResp = await doStub.fetch(new Request("http://localhost/broadcast-image", {
                  method: "POST",
                  body: JSON.stringify({ imageData: result.url, model: result.model, provider: result.provider, source, mediaType: "video", prompt: result.prompt }),
                }));
                Logger.info("[queue] Cloudflare video sync completed");
              } else {
                // 异步任务，调度检查
                await env.CLAWBOT_QUEUE.send({
                  type: "video_check",
                  taskId: result.taskId, videoId: result.videoId, prompt: result.prompt, model: result.model, provider: result.provider, baseUrl: result.baseUrl, apiKey: result.apiKey, source,
                }, { delaySeconds: 30 });
                Logger.info("[queue] Cloudflare video task submitted", { taskId: result.taskId });
              }
            } else {
              Logger.error("[queue] Cloudflare video submit returned null");
              const doId = env.ILINK_CONNECTION.idFromName("main");
              const doStub = env.ILINK_CONNECTION.get(doId);
              await doStub.fetch(new Request("http://localhost/broadcast-image", {
                method: "POST",
                body: JSON.stringify({ error: true, message: `视频生成失败 (${provider} · ${model})`, model, provider, source, mediaType: "video", prompt }),
              }));
            }
          } catch (e: any) {
            Logger.error("[queue] Cloudflare video error", { error: e?.message });
            const doId = env.ILINK_CONNECTION.idFromName("main");
            const doStub = env.ILINK_CONNECTION.get(doId);
            await doStub.fetch(new Request("http://localhost/broadcast-image", {
              method: "POST",
              body: JSON.stringify({ error: true, message: `视频生成失败: ${e?.message || String(e)}`, model, provider, source, mediaType: "video", prompt }),
            }));
          }
        } else {
        // 非 Cloudflare 提供商：REST API
        // 提交视频生成任务
        const { base: vBase, version: vVer } = parseApiUrl(baseUrl || "");
        const isZhipu = (baseUrl || "").includes("bigmodel.cn");
        const submitUrl = isZhipu ? `${vBase}/${vVer}/videos/generations` : `${vBase}/${vVer}/videos`;
        const body = buildVideoSubmitBody(baseUrl || "", model, prompt);
        const resp = await fetch(submitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        });

        if (!resp.ok) {
          const errBody = await resp.text().catch(() => "");
          Logger.error("[queue] Video submit failed", { status: resp.status, body: errBody.slice(0, 200), url: submitUrl, apiKeyPrefix: apiKey.slice(0, 6) });
          continue;
        }

        const data = await resp.json() as any;
        const taskId = data.task_id || data.id;
        const videoId = data.video_id;
        if (!taskId && !videoId) {
          Logger.error("[queue] No task_id or video_id in response", { keys: Object.keys(data || {}) });
          continue;
        }

        // 存储到 DO SQLite（包含 video_id，优先用于查询）
        const doId = env.ILINK_CONNECTION.idFromName("main");
        const doStub = env.ILINK_CONNECTION.get(doId);
        await doStub.fetch(new Request("http://localhost/store-pending-video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId, videoId, prompt, model, provider, baseUrl, apiKey, source }),
        }));

        // 调度首次检查：30 秒后通过 Queue 检查视频状态
        await env.CLAWBOT_QUEUE.send({
          type: "video_check",
          taskId, videoId, prompt, model, provider, baseUrl, apiKey, source,
        }, { delaySeconds: 30 });

        Logger.info("[queue] Video task submitted and stored", { taskId, videoId });
        }

      } else if (type === "video_check") {
        // 轮询视频状态
        const { taskId, videoId } = msg.body;
        if (!taskId && !videoId) {
          Logger.error("[queue] video_check missing taskId/videoId");
          continue;
        }

        // 查询视频状态
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        const { base: cBase, version: cVer } = parseApiUrl(baseUrl || "");
        // 智谱AI用 /async-result/{id}，其他提供商用旧版兼容格式
        const isZhipu = (baseUrl || "").includes("bigmodel.cn");
        // Agnes Video 2.5 轮询需带 model_name（keyframe/reference 模式必需，text 模式也推荐）
        const isNewAgnesVideo = !isZhipu && /^agnes-video-2\.5/i.test(model || "");
        const checkUrl = isZhipu
          ? `${cBase}/${cVer}/async-result/${encodeURIComponent(taskId || videoId)}`
          : videoId
            ? `${cBase}/agnesapi?video_id=${encodeURIComponent(videoId)}${isNewAgnesVideo ? `&model_name=${encodeURIComponent(model)}` : ""}`
            : `${cBase}/${cVer}/videos/${taskId}`;
        const checkResp = await fetch(checkUrl, {
          headers: { "Authorization": `Bearer ${apiKey}` },
        });

        if (!checkResp.ok) {
          const errBody = await checkResp.text().catch(() => "");
          Logger.error("[queue] video_check status query failed", { status: checkResp.status, taskId, url: checkUrl, body: errBody.slice(0, 200) });
          if (checkResp.status === 429 || checkResp.status >= 500) {
            // 限流/服务端错误：不丢弃任务，指数退避后重试（4xx 参数错误直接放弃，等 cron 兜底）
            const retryCount = (msg.body.retryCount || 0) + 1;
            if (retryCount >= MAX_VIDEO_CHECK_ATTEMPTS) {
              const doId = env.ILINK_CONNECTION.idFromName("main");
              const doStub = env.ILINK_CONNECTION.get(doId);
              await doStub.fetch(new Request("http://localhost/store-pending-video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ taskId, status: "failed" }),
              }));
            } else {
              await env.CLAWBOT_QUEUE.send({ ...msg.body, retryCount }, { delaySeconds: videoCheckDelaySec(retryCount) });
            }
          }
          continue;
        }

        const statusData = await checkResp.json() as any;
        // 智谱AI: task_status (SUCCESS/PROCESSING/FAIL), 其他: status (completed/failed)
        const taskStatus = statusData.task_status || statusData.status;
        Logger.info("[queue] video_check status", { taskId, taskStatus, model });

        // 统一判断：完成
        const isCompleted = taskStatus === "completed" || taskStatus === "SUCCESS" || taskStatus === "success";
        const isFailed = taskStatus === "failed" || taskStatus === "FAIL" || taskStatus === "fail";

        if (isCompleted) {
          // 视频完成 — 智谱AI: video_result[0].url, Agnes 2.5: metadata.url, Agnes 旧版: remixed_from_video_id
          const videoUrl = statusData.metadata?.url
            || statusData.video_result?.[0]?.url
            || statusData.remixed_from_video_id
            || statusData.url;
          if (!videoUrl) {
            Logger.error("[queue] video_check completed but no URL", { data: JSON.stringify(statusData).slice(0, 300) });
            continue;
          }

          const doId = env.ILINK_CONNECTION.idFromName("main");
          const doStub = env.ILINK_CONNECTION.get(doId);

          if (source !== "chat" && msg.body.toUserId && msg.body.contextToken) {
            // 微信来源：发送到微信
            try {
              await doStub.fetch(new Request("http://localhost/send-video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ videoUrl, toUserId: msg.body.toUserId, contextToken: msg.body.contextToken, accountId: msg.body.accountId, model, provider, prompt, source }),
              }));
              await doStub.fetch(new Request("http://localhost/store-pending-video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ taskId, videoId, status: "completed", videoUrl }),
              }));
              Logger.info("[queue] Video sent to WeChat", { taskId });
            } catch (e: any) {
              Logger.error("[queue] Video send failed", { error: e?.message, taskId });
            }
          } else {
            // AI测试来源：广播到 WebSocket
            try {
              await doStub.fetch(new Request("http://localhost/broadcast-image", {
                method: "POST",
                body: JSON.stringify({ imageData: videoUrl, model, provider, source, mediaType: "video", prompt }),
              }));
              Logger.info("[queue] Video broadcasted to WebSocket", { taskId });
            } catch (e: any) {
              Logger.error("[queue] Video broadcast failed", { error: e?.message, taskId });
            }
            // 更新状态防止 checkPendingVideos 重复处理
            await doStub.fetch(new Request("http://localhost/store-pending-video", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ taskId, videoId, status: "completed", videoUrl }),
            }));
          }
        } else if (isFailed) {
          Logger.error("[queue] Video generation failed", { taskId, error: JSON.stringify(statusData.error).slice(0, 200) });
          const doId = env.ILINK_CONNECTION.idFromName("main");
          const doStub = env.ILINK_CONNECTION.get(doId);
          const errMsg = `视频生成失败 (${provider} · ${model})`;
          await doStub.fetch(new Request("http://localhost/broadcast-image", {
            method: "POST",
            body: JSON.stringify({ error: true, message: errMsg, model, provider, source, mediaType: "video", prompt }),
          }));
          await doStub.fetch(new Request("http://localhost/store-pending-video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId, status: "failed" }),
          }));
        } else {
          // 仍在处理中，指数退避后再检查（30s→60s→120s→…→600s）
          const retryCount = (msg.body.retryCount || 0) + 1;
          if (retryCount >= MAX_VIDEO_CHECK_ATTEMPTS) {
            // 超过最大重试（约 75 分钟），放弃
            Logger.error("[queue] Video check timeout", { taskId, attempts: retryCount });
            const doId = env.ILINK_CONNECTION.idFromName("main");
            const doStub = env.ILINK_CONNECTION.get(doId);
            await doStub.fetch(new Request("http://localhost/broadcast-image", {
              method: "POST",
              body: JSON.stringify({ error: true, message: `视频生成超时 (${provider} · ${model})`, model, provider, source, mediaType: "video", prompt }),
            }));
            await doStub.fetch(new Request("http://localhost/store-pending-video", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ taskId, status: "failed" }),
            }));
          } else {
            await env.CLAWBOT_QUEUE.send({
              ...msg.body,
              retryCount,
            }, { delaySeconds: videoCheckDelaySec(retryCount) });
          }
        }
      }
    } catch (e: any) {
      Logger.error("[queue] Task error", { error: e?.message });
    }
  }
}