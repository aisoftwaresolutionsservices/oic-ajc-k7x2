/* ids.js - unique IDs made ON THE PHONE, so no server is needed to number a record.
   ORD-<deviceId>-<time>-<random>   PAY-<deviceId>-<time>-<random> */
var OICids = (function () {
  var CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  function rand(n) {
    var a = new Uint8Array(n), s = '';
    crypto.getRandomValues(a);
    for (var i = 0; i < n; i++) s += CHARS[a[i] % CHARS.length];
    return s;
  }
  function deviceId() {              // made once per phone, then remembered
    return OICdb.get('meta', 'deviceId').then(function (r) {
      if (r) return r.value;
      var id = 'D' + rand(7);
      return OICdb.put('meta', { key: 'deviceId', value: id }).then(function () { return id; });
    });
  }
  function make(prefix, dev) { return prefix + '-' + dev + '-' + Date.now() + '-' + rand(5); }
  return { rand: rand, deviceId: deviceId, make: make };
})();
