// pages/chat/chat.js
const app = getApp();

Page({
  data: {
    messages: [
      { role: 'bot', content: '你好呀!我是爪爪AI🤖 欢迎来到夹娃娃乐园,有什么想问的呀?' }
    ],
    inputText: '',
    loading: false,
    lastId: ''
  },

  onInput(e) {
    this.setData({ inputText: e.detail.value });
  },

  quickSend(e) {
    const msg = e.currentTarget.dataset.msg;
    this.setData({ inputText: msg }, () => {
      this.send();
    });
  },

  send() {
    const text = this.data.inputText.trim();
    if (!text || this.data.loading) return;

    const history = this.data.messages.slice(-6).map(m => ({
      role: m.role,
      content: m.content
    }));

    this.setData({
      messages: [...this.data.messages, { role: 'user', content: text }],
      inputText: '',
      loading: true
    });

    wx.nextTick(() => {
      this.setData({ lastId: `msg-${this.data.messages.length - 1}` });
    });

    wx.request({
      url: `${app.globalData.apiBase}/api/chat`,
      method: 'POST',
      data: { message: text, history },
      timeout: 30000,
      success: (res) => {
        const reply = (res.data && res.data.reply) || '爪爪没听清呢,再说一次好吗～';
        this.setData({
          messages: [...this.data.messages, { role: 'bot', content: reply }],
          loading: false
        });
        wx.nextTick(() => {
          this.setData({ lastId: `msg-${this.data.messages.length - 1}` });
        });
      },
      fail: () => {
        const fallbacks = [
          '嗯嗯,爪爪明白你的意思啦～',
          '好呀好呀,一起来玩夹娃娃吧!',
          '爪爪觉得你今天一定能抓到大奖哦!',
          '哈哈,说的真有趣!'
        ];
        this.setData({
          messages: [...this.data.messages, { role: 'bot', content: fallbacks[Math.floor(Math.random() * fallbacks.length)] }],
          loading: false
        });
      }
    });
  }
});
