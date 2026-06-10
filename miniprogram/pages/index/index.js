// pages/index/index.js
const app = getApp();

Page({
  data: {
    points: 0,
    giftCount: 0,
    plays: 0
  },

  onShow() {
    const gifts = app.globalData.collectedGifts || [];
    this.setData({
      points: app.globalData.points,
      giftCount: gifts.length,
      plays: wx.getStorageSync('plays') || 0
    });
  },

  goGame() {
    wx.switchTab({ url: '/pages/game/game' });
  },

  goChat() {
    wx.switchTab({ url: '/pages/chat/chat' });
  },

  goProfile() {
    wx.switchTab({ url: '/pages/profile/profile' });
  }
});
