/**
 * The arithmetic behind a filed month-end or year-end record.
 *
 * Split out from the route because these three are the parts that are easy to
 * get quietly wrong and impossible to notice: a window that ends a day early
 * drops the busiest day of the month, and a combined average worked out the
 * obvious way is true of neither property. Both are testable here without a
 * database, and both are tested.
 */

const MONTHS = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];

/** First day of the window, and the first day after it. */
function windowFor(query) {
  if (query.period === "year") {
    const year = Number(query.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
    return { kind: "year", label: String(year), from: year + "-01-01", to: (year + 1) + "-01-01" };
  }
  const m = /^(\d{4})-(\d{2})$/.exec(String(query.month || ""));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    kind: "month",
    label: MONTHS[month - 1] + " " + year,
    from: m[1] + "-" + m[2] + "-01",
    to: nextYear + "-" + String(nextMonth).padStart(2, "0") + "-01",
  };
}

/** How many nights the window spans — the denominator for occupancy. */
function nightsIn(from, to) {
  return Math.round((new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000);
}


/** Adds two property reports into the collective one. */
function combine(reports) {
  const sum = (fn) => reports.reduce((s, r) => s + fn(r), 0);
  const mergeCounts = (fn) => reports.reduce((a, r) => {
    Object.entries(fn(r)).forEach(([k, v]) => { a[k] = (a[k] || 0) + v; });
    return a;
  }, {});

  const nightsSold = sum((r) => r.rooms.nightsSold);
  const nightsAvailable = sum((r) => r.rooms.nightsAvailable);
  const roomRevenue = sum((r) => r.rooms.revenue);
  const facilityTotal = sum((r) => r.facilities.total);

  return {
    rooms: {
      sellable: sum((r) => r.rooms.sellable),
      bookings: sum((r) => r.rooms.bookings),
      nightsSold, nightsAvailable,
      occupancyPercent: nightsAvailable ? Math.round((nightsSold / nightsAvailable) * 100) : 0,
      // Recomputed from the combined totals, never averaged from the two
      // branches: averaging two ADRs weights a 15-room property equally with a
      // 21-room one and gives a figure that is true of neither.
      averageDailyRate: nightsSold ? Math.round(roomRevenue / nightsSold) : 0,
      revPAR: nightsAvailable ? Math.round(roomRevenue / nightsAvailable) : 0,
      revenue: roomRevenue,
      discountsGiven: sum((r) => r.rooms.discountsGiven),
      byRoomType: reports.reduce((a, r) => {
        Object.entries(r.rooms.byRoomType).forEach(([k, v]) => {
          const t = (a[k] = a[k] || { bookings: 0, nights: 0, revenue: 0 });
          t.bookings += v.bookings; t.nights += v.nights; t.revenue += v.revenue;
        });
        return a;
      }, {}),
      bySource: mergeCounts((r) => r.rooms.bySource),
    },
    facilities: {
      total: facilityTotal,
      chargedToRooms: sum((r) => r.facilities.chargedToRooms),
      paidAtTill: sum((r) => r.facilities.paidAtTill),
      byFacility: reports.flatMap((r) =>
        r.facilities.byFacility.map((f) => ({ ...f, property: r.name }))
      ).sort((a, b) => b.revenue - a.revenue),
    },
    collected: {
      byMethod: mergeCounts((r) => r.collected.byMethod),
      payments: sum((r) => r.collected.payments),
      cardFees: sum((r) => r.collected.cardFees),
      total: sum((r) => r.collected.total),
    },
    revenue: { rooms: roomRevenue, facilities: facilityTotal, total: roomRevenue + facilityTotal },
  };
}


module.exports = { windowFor, nightsIn, combine, MONTHS };
