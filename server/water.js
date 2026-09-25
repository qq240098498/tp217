// 水库的水量与水位的口径都集中在这里
const store = require('./store');

function decimalsOf(settings) {
  const precision = Number(settings.levelPrecision) || 0.01;
  return Math.max(0, String(precision).split('.')[1] ? String(precision).split('.')[1].length : 0);
}

function curveOf(data, reservoirId) {
  return data.curves.find((c) => c.reservoirId === reservoirId) || null;
}

function sortedPoints(curve) {
  return (curve.points || []).slice().sort((a, b) => Number(a.level) - Number(b.level));
}

// 由水位查库容：在水位-库容曲线的分段之间线性插值
function capacityAt(curve, level, settings) {
  const points = sortedPoints(curve);
  const result = (value) => store.round(value, 4);
  const target = Number(level);
  if (!points.length) return 0;
  if (target <= Number(points[0].level)) return result(Number(points[0].capacity));
  if (target >= Number(points[points.length - 1].level)) return result(Number(points[points.length - 1].capacity));
  for (let i = 0; i < points.length - 1; i += 1) {
    const low = points[i];
    const high = points[i + 1];
    if (target >= Number(low.level) && target <= Number(high.level)) {
      const ratio = (target - Number(low.level)) / (Number(high.level) - Number(low.level));
      return result(Number(low.capacity) + ratio * (Number(high.capacity) - Number(low.capacity)));
    }
  }
  return result(Number(points[points.length - 1].capacity));
}

// 由库容反查水位：与 capacityAt 用同一条分段曲线，逐段线性反解，
// 不能拿首末两点整体拉直线；同一库容来回倒要能回到原水位（误差不超过水位精度）
function levelAt(curve, capacity, settings) {
  const points = sortedPoints(curve);
  const digits = decimalsOf(settings);
  const target = Number(capacity);
  if (!points.length) return 0;
  if (target <= Number(points[0].capacity)) return store.round(Number(points[0].level), digits);
  if (target >= Number(points[points.length - 1].capacity)) return store.round(Number(points[points.length - 1].level), digits);
  for (let i = 0; i < points.length - 1; i += 1) {
    const low = points[i];
    const high = points[i + 1];
    const capLow = Number(low.capacity);
    const capHigh = Number(high.capacity);
    if (target >= capLow && target <= capHigh) {
      const ratio = (target - capLow) / (capHigh - capLow);
      return store.round(Number(low.level) + ratio * (Number(high.level) - Number(low.level)), digits);
    }
  }
  return store.round(Number(points[points.length - 1].level), digits);
}

// 找到输入值落在曲线上的那个分段（区间内端点归到靠后的段），供接口说明用
function segmentOf(curve, value, by) {
  const points = sortedPoints(curve);
  if (points.length < 2) return null;
  const key = by === 'capacity' ? 'capacity' : 'level';
  const x0 = Number(points[0][key]);
  const xn = Number(points[points.length - 1][key]);
  const target = Number(value);
  if (target <= x0 || target >= xn) return null;
  for (let i = 0; i < points.length - 1; i += 1) {
    const low = points[i];
    const high = points[i + 1];
    if (target >= Number(low[key]) && target <= Number(high[key])) {
      return {
        index: i,
        lowLevel: Number(low.level),
        lowCapacity: Number(low.capacity),
        highLevel: Number(high.level),
        highCapacity: Number(high.capacity),
      };
    }
  }
  return null;
}

// 汛期判断与限水位
function inFloodSeason(dateStr, settings) {
  const parts = String(dateStr || '').split('-');
  if (parts.length !== 3) return false;
  const month = Number(parts[1]);
  const startMonth = Number(String(settings.floodSeasonStart).split('-')[0]);
  const endMonth = Number(String(settings.floodSeasonEnd).split('-')[0]);
  return month >= startMonth && month <= endMonth;
}

function limitLevelOf(reservoir, dateStr, settings) {
  return inFloodSeason(dateStr, settings) ? Number(reservoir.floodLimitLevel) : Number(reservoir.normalLevel);
}

function levelCheck(reservoir, level, dateStr, settings) {
  const limit = limitLevelOf(reservoir, dateStr, settings);
  const over = store.round(Number(level) - limit, 2);
  return { limit, level: Number(level), over, exceeded: over > 0, floodSeason: inFloodSeason(dateStr, settings) };
}

// 预警等级：水位到警戒/汛限，或者入库流量超过门槛，都要提级
function warningOf(reservoir, level, inflowFlow, settings) {
  const levelValue = Number(level);
  const flow = Number(inflowFlow);
  let grade = '正常';
  if (levelValue >= Number(reservoir.floodLimitLevel)) grade = '严重';
  else if (levelValue >= Number(reservoir.warningLevel)) grade = '警戒';
  else if (levelValue >= Number(reservoir.warningLevel) - 0.5) grade = '注意';
  return { level: grade, byLevel: grade, inflowFlow: flow };
}

// 时段水量平衡：入库水量 - 出库水量 - 损失 = 蓄变
function balance(data, reservoirId, fromDate, toDate) {
  const settings = data.settings;
  const reservoir = data.reservoirs.find((r) => r.id === reservoirId);
  const curve = curveOf(data, reservoirId);
  if (!reservoir || !curve) return null;

  const from = data.levels
    .filter((l) => l.reservoirId === reservoirId && l.date >= fromDate && l.date <= toDate)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const days = store.daysBetween(fromDate, toDate);

  const inflowRows = data.inflows.filter((r) => r.reservoirId === reservoirId && r.date >= fromDate && r.date < toDate);
  const releaseRows = data.releases.filter((r) => r.reservoirId === reservoirId && r.date >= fromDate && r.date < toDate);
  const meanInflow = store.round(inflowRows.reduce((s, r) => s + Number(r.flow), 0) / Math.max(1, inflowRows.length), 3);
  const meanRelease = store.round(releaseRows.reduce((s, r) => s + Number(r.flow), 0) / Math.max(1, releaseRows.length), 3);

  const inflowVolume = store.round((meanInflow * days * 86400) / 10000, 3);
  const releaseVolume = store.round((meanRelease * days * 3600) / 10000, 3);
  const lossVolume = 0;
  const startLevel = from.length ? Number(from[0].level) : 0;
  const endLevel = from.length ? Number(from[from.length - 1].level) : 0;
  const startCapacity = curve ? capacityAt(curve, startLevel, settings) : 0;
  const endCapacity = curve ? capacityAt(curve, endLevel, settings) : 0;
  const deltaStorage = store.round(endCapacity - startCapacity, 3);
  const residual = store.round(inflowVolume - releaseVolume - lossVolume - deltaStorage, 3);
  const balanced = Math.abs(residual) < Number(settings.balanceToleranceWan);
  return {
    reservoirId,
    reservoirName: reservoir.name,
    fromDate,
    toDate,
    days,
    meanInflow,
    meanRelease,
    inflowVolume,
    releaseVolume,
    lossVolume,
    startLevel,
    endLevel,
    startCapacity,
    endCapacity,
    deltaStorage,
    residual,
    tolerance: Number(settings.balanceToleranceWan),
    balanced,
  };
}

module.exports = {
  decimalsOf,
  curveOf,
  sortedPoints,
  capacityAt,
  levelAt,
  segmentOf,
  inFloodSeason,
  limitLevelOf,
  levelCheck,
  warningOf,
  balance,
};
