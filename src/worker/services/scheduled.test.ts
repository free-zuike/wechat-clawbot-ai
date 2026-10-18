import { describe, it, expect } from "vitest";
import { parseReminderCommand, formatRunAt, formatRepeat } from "./scheduled";

const NOW = new Date("2025-06-10T10:00:00+08:00").getTime(); // 周二 10:00

describe("parseReminderCommand - 相对时间", () => {
  it("30分钟后", () => {
    const r = parseReminderCommand("/提醒 30分钟后 该喝水了", NOW);
    expect(r.kind).toBe("create");
    expect(r.runAt).toBe(NOW + 30 * 60000);
    expect(r.repeatInterval).toBe(0);
    expect(r.content).toBe("该喝水了");
  });

  it("2小时后", () => {
    const r = parseReminderCommand("/提醒 2小时后 开会", NOW);
    expect(r.kind).toBe("create");
    expect(r.runAt).toBe(NOW + 2 * 3600000);
    expect(r.content).toBe("开会");
  });

  it("1天后", () => {
    const r = parseReminderCommand("/提醒 1天后 交房租", NOW);
    expect(r.runAt).toBe(NOW + 24 * 3600000);
  });

  it("自然语言：提醒我30分钟后", () => {
    const r = parseReminderCommand("提醒我30分钟后喝水", NOW);
    expect(r.kind).toBe("create");
    expect(r.runAt).toBe(NOW + 30 * 60000);
    expect(r.content).toBe("喝水");
  });
});

describe("parseReminderCommand - 绝对时间", () => {
  it("今天 20:00", () => {
    const r = parseReminderCommand("/提醒 今天20:00 更新博客", NOW);
    expect(r.kind).toBe("create");
    expect(r.runAt).toBe(NOW + 10 * 3600000); // 10:00 → 20:00
  });

  it("明天早上8点", () => {
    const r = parseReminderCommand("/提醒 明天早上8点 买早餐", NOW);
    expect(r.kind).toBe("create");
    expect(r.runAt).toBe(NOW + 22 * 3600000); // 明天 08:00
  });

  it("过去的今天时间自动顺延一天", () => {
    const r = parseReminderCommand("/提醒 今天7点 早起", NOW); // 10:00 已过 7:00
    expect(r.runAt).toBe(NOW + 21 * 3600000); // 明天 07:00
  });
});

describe("parseReminderCommand - 重复任务", () => {
  it("每天早上8点", () => {
    const r = parseReminderCommand("/提醒 每天早上8点 推新闻", NOW);
    expect(r.kind).toBe("create");
    expect(r.repeatInterval).toBe(24 * 3600000);
    expect(r.content).toBe("推新闻");
  });

  it("每周一9点", () => {
    const r = parseReminderCommand("/提醒 每周一9点 周会", NOW); // 6/10 是周二
    expect(r.kind).toBe("create");
    expect(r.repeatInterval).toBe(7 * 24 * 3600000);
    expect(r.runAt).toBe(NOW + 6 * 24 * 3600000 - 1 * 3600000); // 下周一 09:00
  });

  it("每2小时", () => {
    const r = parseReminderCommand("/提醒 每2小时 站起来活动", NOW);
    expect(r.kind).toBe("create");
    expect(r.repeatInterval).toBe(2 * 3600000);
    expect(r.runAt).toBe(NOW + 2 * 3600000);
  });

  it("每月1日10点", () => {
    const r = parseReminderCommand("/提醒 每月1日10点 交话费", NOW);
    expect(r.kind).toBe("create");
    expect(r.content).toBe("交话费");
    // 6/10 → 下个月 7/1 10:00
    const expected = new Date("2025-07-01T10:00:00+08:00").getTime();
    expect(r.runAt).toBe(expected);
  });
});

describe("parseReminderCommand - 管理命令", () => {
  it("列表", () => {
    expect(parseReminderCommand("/提醒列表", NOW).kind).toBe("list");
    expect(parseReminderCommand("/提醒 列表", NOW).kind).toBe("list");
  });

  it("取消", () => {
    const r = parseReminderCommand("/提醒取消 rm_abc123", NOW);
    expect(r.kind).toBe("cancel");
    expect(r.cancelId).toBe("rm_abc123");
  });

  it("清空", () => {
    expect(parseReminderCommand("/提醒清空", NOW).kind).toBe("clear");
  });

  it("非提醒文本返回 null", () => {
    expect(parseReminderCommand("今天天气怎么样", NOW).kind).toBeNull();
    expect(parseReminderCommand("你好", NOW).kind).toBeNull();
  });
});

describe("formatRunAt / formatRepeat", () => {
  it("格式化时间", () => {
    expect(formatRunAt(NOW, NOW)).toBe("今天 10:00");
    expect(formatRunAt(NOW + 24 * 3600000, NOW)).toBe("明天 10:00");
  });

  it("格式化重复", () => {
    expect(formatRepeat(0)).toBe("一次性");
    expect(formatRepeat(24 * 3600000)).toBe("每 1 天");
    expect(formatRepeat(2 * 3600000)).toBe("每 2 小时");
  });
});
