/* db.js - the phone's notebook (IndexedDB).
   Seven "drawers" (stores). Each drawer has a key that makes every record unique. */
var OICdb = (function () {
  var DB_NAME = 'oic', VERSION = 1;
  var KEYS = { items: 'k', customers: 'k', staff: 'k', openInvoices: 'orderId',
               orders: 'orderId', payments: 'paymentId', meta: 'key' };
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = function () {           // runs once, when the notebook is first created
        var db = req.result;
        Object.keys(KEYS).forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: KEYS[name] });
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  // Run one transaction on one drawer. fn receives the drawer and may return a request.
  function run(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var req = fn(t.objectStore(store));
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  return {
    put: function (store, obj) { return run(store, 'readwrite', function (os) { return os.put(obj); }); },
    putMany: function (store, arr) {
      return run(store, 'readwrite', function (os) { arr.forEach(function (o) { os.put(o); }); });
    },
    get: function (store, key) { return run(store, 'readonly', function (os) { return os.get(key); }); },
    getAll: function (store) { return run(store, 'readonly', function (os) { return os.getAll(); }); },
    del: function (store, key) { return run(store, 'readwrite', function (os) { return os.delete(key); }); },
    clear: function (store) { return run(store, 'readwrite', function (os) { return os.clear(); }); }
  };
})();
