// pages/profile/profile.js
const app = getApp();

const LEVELS = [
  { name: '新手玩家', min: 0 },
  { name: '初级玩家', min: 50 },
  { name: '熟练玩家', min: 150 },
  { name: '高级玩家', min: 300 },
  { name: '夹娃娃达人', min: 600 },
  { name: '传说级玩家', min: 1000 }
];

function getLevel(points) {
  let cur = LEVELS[0];
  let next = LEVELS[1];
  for (let i = 0; i < LEVELS.length; i++) {
    if (points >= LEVELS[i].min) {
      cur = LEVELS[i];
      next = LEVELS[i + 1] || LEVELS[i];
    }
  }
  return { cur, next };
}

Page({
  data: {
    points: 0,
    collectedGifts: [],
    giftCount: 0,
    plays: 0,
    rareCount: 0,
    levelText: '',
    progressPercent: 0,
    nextLevel: 0
  },

  onShow() {
    const gifts = app.globalData.collectedGifts || [];
    const plays = wx.getStorageSync('plays') || 0;
    const rareCount = gifts.filter(g => g.rarity === 'rare' || g.rarity === 'legendary').length;
    const points = app.globalData.points;
    const { cur, next } = getLevel(points);

    this.setData({
      points,
      collectedGifts: gifts,
      giftCount: gifts.length,
      plays,
      rareCount,
      levelText: cur.name,
      progressPercent: Math.min(100, ((points - cur.min) / Math.max(1, next.min - cur.min)) * 100),
      nextLevel: Math.max(0, next.min - points)
    });
  }
});
