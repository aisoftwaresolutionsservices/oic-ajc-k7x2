/* pin.js - offline login. The phone never stores a PIN, only a hash from the server.
   The recipe MUST match hashPin_ in Code.gs exactly: SHA-256 of  salt|name(lowercase)|pin
   Needs HTTPS (or localhost): crypto.subtle does not exist on plain http pages. */
var OICpin = (function () {
  function hash(salt, name, pin) {
    var raw = salt + '|' + String(name).trim().toLowerCase() + '|' + String(pin).trim();
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    });
  }
  // Resolves to the staff record if name + PIN are right, otherwise null.
  function verifyOffline(name, pin) {
    return Promise.all([OICdb.get('meta', 'salt'), OICdb.getAll('staff')]).then(function (r) {
      var salt = r[0] && r[0].value;
      if (!salt) return null;                                   // never synced: refuse
      var want = String(name).trim().toLowerCase();
      var row = r[1].filter(function (s) { return s.name.toLowerCase() === want; })[0];
      if (!row || !row.pinHash) return null;
      return hash(salt, name, pin).then(function (h) { return h === row.pinHash ? row : null; });
    });
  }
  return { hash: hash, verifyOffline: verifyOffline };
})();
