// utils/validators.js — Bangladesh-specific validation helpers
const BD_MOBILE_REGEX = /^01[3-9]\d{8}$/;
const NID_REGEX = /^\d{10}$|^\d{17}$/; // 10 or 17 digit NID

function isValidBdMobile(phone) {
  return BD_MOBILE_REGEX.test(String(phone || '').trim());
}

function isValidNid(nid) {
  return NID_REGEX.test(String(nid || '').trim());
}

module.exports = { BD_MOBILE_REGEX, NID_REGEX, isValidBdMobile, isValidNid };
