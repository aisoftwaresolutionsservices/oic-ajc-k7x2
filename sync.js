/* sync.js - the clerk who carries the notebook to the ledger.
   1. PUSH: send Pending orders and payments in batches. Mark each Synced or Rejected.
   2. PULL: download prices, customers, staff, open invoices.
   Safe to run twice: the server accepts a known ID again without saving it twice. */
var OICsync = (function () {
  var RETRY = { ORDER_NOT_FOUND: 1, ORIGINAL_NOT_FOUND: 1, REP_MISMATCH: 1 };   // not rejected: wait for the right rep or the parent record
  var MAX_O = 50, MAX_P = 100;

  // text/plain keeps the browser from sending a CORS "pre-flight" request that Apps Script cannot answer.
  function call(body) {
    return fetch(OIC_SETTINGS.API_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body), redirect: 'follow'
    }).then(function (r) { return r.json(); });
  }
  function auth(session, dev) {
    return { syncKey: OIC_SETTINGS.SYNC_KEY, deviceId: dev, staff: session.staff, pin: session.pin };
  }
  function clean(rec) {                       // never send the phone-only fields
    var c = {};
    Object.keys(rec).forEach(function (k) { if (k !== 'sync' && k !== 'error' && k !== 'prevSync' && k !== 'stub') c[k] = rec[k]; });
    return c;
  }
  function fail(res) { return new Error(res.error + (res.message ? ': ' + res.message : '')); }

  function pending(store) {
    return OICdb.getAll(store).then(function (a) {
      return a.filter(function (x) { return x.sync === 'Pending'; })
              .sort(function (x, y) { return (x.error ? 1 : 0) - (y.error ? 1 : 0); }); // retry-later ones go last
    });
  }

  // Apply the server's answer to a list of records. Returns the number whose state changed.
  function apply(list, store, keyName, accepted, rejected) {
    var jobs = [], changed = 0;
    list.forEach(function (rec) {
      var id = rec[keyName];
      if (accepted.indexOf(id) >= 0) {
        rec.sync = 'Synced'; rec.error = ''; changed++; jobs.push(OICdb.put(store, rec));
        return;
      }
      var rj = rejected.filter(function (x) { return x.id === id; })[0];
      if (!rj) return;
      if (RETRY[rj.error]) { rec.error = rj.error; jobs.push(OICdb.put(store, rec)); }       // stays Pending
      else { rec.sync = 'Rejected'; rec.error = rj.error + ': ' + rj.message; changed++; jobs.push(OICdb.put(store, rec)); }
    });
    return Promise.all(jobs).then(function () { return changed; });
  }

  function pushOnce(session, dev) {
    return Promise.all([pending('orders'), pending('payments')]).then(function (r) {
      var orders = r[0].slice(0, MAX_O), pays = r[1].slice(0, MAX_P);
      if (!orders.length && !pays.length) return 0;
      var body = Object.assign(auth(session, dev), { action: 'syncAll', orders: orders.map(clean), payments: pays.map(clean) });
      return call(body).then(function (res) {
        if (!res.ok) throw fail(res);
        return Promise.all([
          apply(orders, 'orders', 'orderId', res.acceptedOrders, res.rejectedOrders),
          apply(pays, 'payments', 'paymentId', res.acceptedPayments, res.rejectedPayments)
        ]).then(function (n) { return n[0] + n[1]; });
      });
    });
  }

  function keyOf(row, name) {                 // the unique value of an Item or Student row
    var v = row[name];
    return String(v !== undefined && v !== '' ? v : JSON.stringify(row));
  }

  function pull(session, dev) {
    return OICdb.get('meta', 'lastSync').then(function (m) {
      return call(Object.assign(auth(session, dev), { action: 'getUpdates', since: m ? m.value : 0 }));
    }).then(function (res) {
      if (!res.ok) throw fail(res);
      var items = res.items.map(function (r) { return Object.assign({ k: keyOf(r, OIC_SETTINGS.ITEM_KEY) }, r); });
      var custs = res.customers.map(function (r) { return Object.assign({ k: keyOf(r, OIC_SETTINGS.CUST_KEY) }, r); });
      var staff = res.staff.map(function (s) { return { k: s.name.toLowerCase(), name: s.name, role: s.role, pinHash: s.pinHash }; });
      var open = res.openInvoices;
      return OICdb.putMany('items', items)
        .then(function () { return OICdb.putMany('customers', custs); })
        .then(function () { return OICdb.clear('staff'); })
        .then(function () { return OICdb.putMany('staff', staff); })
        .then(function () { return OICdb.clear('openInvoices'); })
        .then(function () { return OICdb.putMany('openInvoices', open); })
        .then(function () { return OICdb.put('meta', { key: 'salt', value: res.salt }); })
        .then(function () { return OICdb.put('meta', { key: 'lastSync', value: res.serverTime }); })
        .then(function () { return { items: items.length, customers: custs.length, open: open.length }; });
    });
  }

  // Online only: the payments of one invoice (the owner needs this to reverse a payment).
  function getPayments(session, orderId) {
    return OICids.deviceId().then(function (dev) {
      return call(Object.assign(auth(session, dev), { action: 'getPayments', orderId: orderId }));
    }).then(function (res) { if (!res.ok) throw fail(res); return res.payments; });
  }

  function syncNow(session) {
    return OICids.deviceId().then(function (dev) {
      function loop() { return pushOnce(session, dev).then(function (n) { return n > 0 ? loop() : null; }); }
      return loop().then(function () { return pull(session, dev); });
    });
  }

  return { syncNow: syncNow, getPayments: getPayments, call: call };
})();
