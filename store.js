/* store.js - saving on the phone. NOTHING here touches the network.
   Every record starts as sync:'Pending'. sync.js later sends it and marks it 'Synced' or 'Rejected'. */
var OICstore = (function () {
  function round2(n) { return Math.round(n * 100) / 100; }

  function saveOrder(session, o) {          // o = { customer, gsm, items:[{qty,price,...}], total }
    return OICids.deviceId().then(function (dev) {
      var rec = { orderId: OICids.make('ORD', dev), dateTime: new Date().toISOString(),
                  rep: session.staff, customer: o.customer, gsm: o.gsm || '',
                  total: o.total, items: o.items, sync: 'Pending', error: '' };
      return OICdb.put('orders', rec).then(function () { return rec; });
    });
  }

  function savePayment(session, p) {        // p = { orderId, method, amount, reference }
    return OICids.deviceId().then(function (dev) {
      var rec = { paymentId: OICids.make('PAY', dev), orderId: p.orderId,
                  dateTime: new Date().toISOString(), rep: session.staff, method: p.method,
                  amount: p.amount, reference: p.reference || '', type: 'Payment',
                  sync: 'Pending', error: '' };
      return OICdb.put('payments', rec).then(function () { return rec; });
    });
  }

  // original = a payment record (from this phone, or from getPayments for the owner)
  function saveReversal(session, original, reason) {
    return OICids.deviceId().then(function (dev) {
      var rec = { paymentId: OICids.make('PAY', dev), orderId: original.orderId,
                  dateTime: new Date().toISOString(), rep: session.staff, method: original.method,
                  amount: original.amount,   // the server ignores this and uses the original's amount
                  type: 'Reversal', reversalOf: original.paymentId, reason: reason,
                  sync: 'Pending', error: '' };
      return OICdb.put('payments', rec).then(function () { return rec; });
    });
  }

  // Mark an order Deleted (the row is never erased).
  function deleteOrder(session, orderId, reason, customer) {
    return OICdb.get('orders', orderId).then(function (rec) {
      if (rec) {
        rec.prevSync = rec.sync; rec.status = 'Deleted'; rec.reason = reason; rec.sync = 'Pending'; rec.error = '';
        return OICdb.put('orders', rec);
      }
      // an invoice made on another phone: send a small delete request
      return OICdb.put('orders', { orderId: orderId, status: 'Deleted', reason: reason, rep: session.staff,
                                   customer: customer || '-', stub: true, sync: 'Pending', error: '' });
    });
  }

  // Balance on the phone = server balance (last sync)
  //                        minus payments saved here and still Pending
  //                        plus reversals saved here and still Pending
  function localBalance(orderId) {
    return Promise.all([OICdb.get('openInvoices', orderId), OICdb.get('orders', orderId),
                        OICdb.getAll('payments')]).then(function (r) {
      var open = r[0], mine = r[1], pays = r[2];
      var base = open ? open.balance : (mine && mine.sync !== 'Synced' && !mine.stub ? mine.total : 0);
      pays.forEach(function (p) {
        if (p.orderId !== orderId || p.sync !== 'Pending') return;
        base += (p.type === 'Reversal' ? p.amount : -p.amount);
      });
      return round2(base);
    });
  }

  return { saveOrder: saveOrder, savePayment: savePayment, saveReversal: saveReversal,
           deleteOrder: deleteOrder, localBalance: localBalance };
})();
