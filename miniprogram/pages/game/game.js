// pages/game/game.js
const app = getApp();

Page({
  data: {
    clawX: 0,
    clawY: 0,
    clawGrabbing: false,
    isPlaying: false,
    statusText: '点击按钮开始夹娃娃吧!',
    points: 0,
    showResult: false,
    resultGift: null,
    resultTitle: '',
    resultMessage: '',
    resultStory: '',
    rarityText: ''
  },

  onShow() {
    this.setData({ points: app.globalData.points });
  },

  playClaw() {
    if (this.data.isPlaying) return;
    this.setData({ isPlaying: true, statusText: '爪子正在移动...' });

    const targetX = (Math.random() - 0.5) * 300;
    const targetY = 150;

    this.setData({ clawX: targetX, clawY: targetY });

    setTimeout(() => {
      this.setData({ clawGrabbing: true, statusText: '夹取中...' });
    }, 800);

    setTimeout(() => {
      this.setData({ clawGrabbing: false, clawY: 0, clawX: 0, statusText: '结果揭晓!' });
    }, 1600);

    setTimeout(() => {
      this.fetchPlayResult();
    }, 2400);
  },

  fetchPlayResult() {
    const api = `${app.globalData.apiBase}/api/play`;
    const plays = (wx.getStorageSync('plays') || 0) + 1;
    wx.setStorageSync('plays', plays);

    wx.request({
      url: api,
      method: 'POST',
      data: { userName: '玩家', attempts: plays },
      success: (res) => {
        const data = res.data || {};
        if (data.success && data.gift) {
          app.addGift(data.gift);
          this.setData({
            points: app.globalData.points,
            showResult: true,
            resultGift: data.gift,
            resultTitle: `抓到了 ${data.gift.name}!`,
            resultMessage: data.message,
            resultStory: data.story || '',
            rarityText: this.rarityLabel(data.gift.rarity),
            isPlaying: false,
            statusText: '恭喜你!再来一次?'
          });
        } else {
          this.setData({
            showResult: true,
            resultGift: null,
            resultTitle: '差一点点...',
            resultMessage: data.message || '没抓到,再来一次吧!',
            resultStory: '',
            rarityText: '',
            isPlaying: false,
            statusText: '加油,下一次一定抓到!'
          });
        }
      },
      fail: () => {
        const success = Math.random() > 0.3;
        if (success) {
          const gift = this.fallbackGift();
          app.addGift(gift);
          this.setData({
            points: app.globalData.points,
            showResult: true,
            resultGift: gift,
            resultTitle: `抓到了 ${gift.name}!`,
            resultMessage: `恭喜玩家抓到了${gift.emoji}${gift.name}!`,
            resultStory: `哇,你抓到了${gift.name},运气真好呀!`,
            rarityText: this.rarityLabel(gift.rarity),
            isPlaying: false,
            statusText: '恭喜你!'
          });
        } else {
          this.setData({
            showResult: true,
            resultGift: null,
            resultTitle: '差一点点...',
            resultMessage: '没抓到,再来一次吧!',
            isPlaying: false,
            statusText: '加油!'
          });
        }
      }
    });
  },

  fallbackGift() {
    const gifts = [
      { name: '小兔子', emoji: '🐰', rarity: 'common', points: 10 },
      { name: '小猫咪', emoji: '🐱', rarity: 'common', points: 15 },
      { name: '小熊玩偶', emoji: '🧸', rarity: 'rare', points: 100 },
      { name: '独角兽', emoji: '🦄', rarity: 'rare', points: 80 }
    ];
    return gifts[Math.floor(Math.random() * gifts.length)];
  },

  rarityLabel(r) {
    const map = {
      common: '✨ 普通',
      uncommon: '💫 稀有',
      rare: '🌟 珍贵',
      legendary: '🏆 传说'
    };
    return map[r] || '✨ 普通';
  },

  closeModal() {
    this.setData({ showResult: false });
  },

  stopProp() {}
});
