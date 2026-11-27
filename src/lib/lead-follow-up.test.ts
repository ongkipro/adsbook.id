import assert from "node:assert/strict";
import test from "node:test";
import { ABANDONED_RETENTION_DAYS } from "./order-persistence.ts";
import { LEAD_FOLLOW_UP_LABELS, LEAD_FOLLOW_UP_STATUSES, LEAD_FOLLOW_UP_TONE, LEAD_RETENTION_DAYS, isLeadFollowUpStatus, leadAge, leadDaysLeft } from "./lead-follow-up.ts";

const now = new Date("2026-11-27T10:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const H = 3_600_000;
const D = 24 * H;

test("every follow-up status has its own colour, and the colours differ", () => {
  for (const status of LEAD_FOLLOW_UP_STATUSES) {
    assert.ok(LEAD_FOLLOW_UP_LABELS[status], `${status} has a label`);
    assert.ok(LEAD_FOLLOW_UP_TONE[status]?.dot, `${status} has a dot colour`);
  }
  const dots = LEAD_FOLLOW_UP_STATUSES.map((status) => LEAD_FOLLOW_UP_TONE[status].dot);
  assert.equal(new Set(dots).size, dots.length, "no two statuses share a colour");
  assert.match(LEAD_FOLLOW_UP_TONE.new.dot, /amber/, "a lead not yet contacted reads as needing action");
  assert.doesNotMatch(LEAD_FOLLOW_UP_TONE.not_interested.label, /rose|red/, "not interested is closed, not an error");
});

test("only the four stored statuses are accepted", () => {
  for (const status of LEAD_FOLLOW_UP_STATUSES) assert.equal(isLeadFollowUpStatus(status), true);
  for (const bad of ["converted", "", null, "NEW", 1]) assert.equal(isLeadFollowUpStatus(bad), false, String(bad));
});

test("a lead's age reads in the unit an operator works by", () => {
  assert.equal(leadAge(ago(20_000), now), "baru saja");
  assert.equal(leadAge(ago(25 * 60_000), now), "25 menit lalu");
  assert.equal(leadAge(ago(5 * H), now), "5 jam lalu");
  assert.equal(leadAge(ago(3 * D + H), now), "3 hari lalu");
  assert.equal(leadAge("not a date", now), null);
  assert.equal(leadAge(new Date(now.getTime() + 10 * 60_000).toISOString(), now), null, "a future time is not shown");
});

test("the purge countdown shows only in a lead's last three days, and matches the purge", () => {
  assert.equal(LEAD_RETENTION_DAYS, ABANDONED_RETENTION_DAYS, "the countdown uses the purge's own number");
  assert.equal(leadDaysLeft(ago(2 * D), now), null, "12 days left: not shown");
  assert.equal(leadDaysLeft(ago(11 * D), now), null, "exactly 3 days left: not shown yet");
  assert.equal(leadDaysLeft(ago(11 * D + H), now), 2, "2 days and 23 hours: 2 whole days");
  assert.equal(leadDaysLeft(ago(12 * D + H), now), 1);
  assert.equal(leadDaysLeft(ago(14 * D - 5 * 60_000), now), 0, "minutes left read as today, not one day");
  assert.equal(leadDaysLeft(ago(14 * D + H), now), 0, "past due: removed at the next hourly purge");
  assert.equal(leadDaysLeft(null, now), null);
});
