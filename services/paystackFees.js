/**
 * Paystack fee arithmetic.
 *
 * All of it lives here so there is exactly one place to change when Paystack
 * changes pricing. Never compute a fee in the browser — a fee the client
 * calculates is a fee the client can edit.
 *
 * IMPORTANT — check your Paystack dashboard before relying on this.
 * Paystack has a setting that passes fees to the customer automatically, with
 * no code. If that setting is ON, set PASS_FEES_IN_CODE to false below, or the
 * guest is charged the fee twice.
 *
 * Rates below are Nigerian local-card pricing as published in 2026. Sources
 * disagree on whether the cap is ₦2,000 or ₦2,500 — confirm on the dashboard
 * and change CAP here.
 */

const FEE_CONFIG = {
  // Set false if Paystack's dashboard is already adding the fee for you.
  PASS_FEES_IN_CODE: process.env.PAYSTACK_PASS_FEES !== "false",

  PERCENTAGE: 0.015,      // 1.5% on local cards
  FLAT: 100,              // ₦100 flat
  FLAT_WAIVED_BELOW: 2500, // flat fee waived at or below this amount
  CAP: 2000,              // maximum fee on a local card transaction
  VAT: 0.075,             // 7.5% VAT charged on the processing fee itself
  APPLY_VAT: true,
};

const round = (n) => Math.round(n * 100) / 100;

/**
 * What Paystack will deduct from a transaction of `amount`.
 * This is the fee the HOTEL pays if fees are absorbed.
 */
function feeOn(amount) {
  if (amount <= 0) return 0;
  const flat = amount <= FEE_CONFIG.FLAT_WAIVED_BELOW ? 0 : FEE_CONFIG.FLAT;
  let fee = amount * FEE_CONFIG.PERCENTAGE + flat;
  if (fee > FEE_CONFIG.CAP) fee = FEE_CONFIG.CAP;
  if (FEE_CONFIG.APPLY_VAT) fee += fee * FEE_CONFIG.VAT;
  return round(fee);
}

/**
 * Grosses a target up so the hotel nets exactly `target` after Paystack's cut.
 *
 * The naive approach — target + feeOn(target) — is wrong, because the fee is a
 * percentage of the LARGER amount actually charged. Solve for it instead:
 *
 *   charge = (target + flat) / (1 - percentage)
 *
 * then re-check against the cap, because past a certain size the cap makes the
 * gross-up a simple addition again. A three-night crown stay (₦195,000) is well
 * past that point, so this branch matters in practice, not in theory.
 */
function grossUp(target) {
  if (!FEE_CONFIG.PASS_FEES_IN_CODE) {
    return { roomTotal: target, fee: 0, totalPayable: target, feesPassedToGuest: false };
  }
  if (target <= 0) {
    return { roomTotal: 0, fee: 0, totalPayable: 0, feesPassedToGuest: true };
  }

  const { PERCENTAGE, FLAT, FLAT_WAIVED_BELOW, CAP, VAT, APPLY_VAT } = FEE_CONFIG;
  const vatMultiplier = APPLY_VAT ? 1 + VAT : 1;

  const solve = (flat) => (target + flat * vatMultiplier) / (1 - PERCENTAGE * vatMultiplier);

  // The waiver is judged on the amount actually charged, not on the target. A
  // target just under the threshold can gross up to just over it, which brings
  // the flat fee back and leaves the hotel short. So assume the waiver, then
  // re-solve with the flat fee if the result crossed the line.
  let flat = target <= FLAT_WAIVED_BELOW ? 0 : FLAT;
  let charge = solve(flat);
  if (flat === 0 && charge > FLAT_WAIVED_BELOW) {
    flat = FLAT;
    charge = solve(flat);
  }
  let fee = charge - target;

  // If that fee exceeds the cap, the cap governs and the sum is simply additive.
  const cappedFee = CAP * vatMultiplier;
  if (fee > cappedFee) {
    fee = cappedFee;
    charge = target + fee;
  }

  fee = round(fee);
  return {
    roomTotal: round(target),
    fee,
    totalPayable: round(target + fee),
    feesPassedToGuest: true,
  };
}

/** Splits a settled payment into what the hotel keeps and what Paystack took. */
function splitSettlement(amountPaid, roomTotal) {
  const fee = round(Math.max(0, amountPaid - roomTotal));
  return { amountPaid: round(amountPaid), feeAmount: fee, netAmount: round(amountPaid - fee) };
}

module.exports = { FEE_CONFIG, feeOn, grossUp, splitSettlement };
