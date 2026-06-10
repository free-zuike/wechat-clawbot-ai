// app.js
App({
  globalData: {
    userInfo: null,
    points: 0,
    collectedGifts: [],
    apiBase: 'https://your-worker.your-domain.workers.dev'
  },

  onLaunch() {
    const stored = wx.getStorageSync('collectedGifts') || [];
    this.globalData.collectedGifts = stored;
    this.globalData.points = wx.getStorageSync('points') || 0;
  },

  addGift(gift) {
    this.globalData.collectedGifts.unshift({ ...gift, time: Date.now() });
    this.globalData.points += gift.points;
    wx.setStorageSync('collectedGifts', this.globalData.collectedGifts);
    wx.setStorageSync('points', this.globalData.points);
  }
});
