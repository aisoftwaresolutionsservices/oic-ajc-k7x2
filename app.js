/* app.js - the screens of OIC. All saving goes through store.js (works offline);
   sync.js moves records to and from the Google Sheet when there is a signal. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // A name that starts with = + - @ could run as a formula in a Sheet. Strip those characters.
  function cleanText(s) { return String(s || '').trim().replace(/^[=+\-@\s]+/, ''); }
  function round2(n) { return Math.round(n * 100) / 100; }
  var formatMoney = function (n) { return '\u20a6' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

  var BRAND_COLORS = { MTN: { main: '#FFCC00', text: '#241238' }, AIRTEL: { main: '#ED1C24', text: '#FFFFFF' }, GLO: { main: '#39A935', text: '#FFFFFF' }, '9MOBILE': { main: '#00A99D', text: '#FFFFFF' } };
  var DEFAULT_BRAND = { main: '#8B3FE0', text: '#FFFFFF' };
  var PML = { normal: 'Normal', discount50k: 'Discount 0.50k', discountN1: 'Discount N1' };

  var session = null;                      // { staff, pin, role }
  var PRODUCTS = [], CATEGORIES = [], activeCategory = null, customers = [];
  var qty = {}, priceMode = {};
  var syncing = false, reportFilter = 'all';
  var inv = null;                          // the invoice being confirmed
  var payChoice = null, payMethod = 'Cash';
  var collectFor = null, cMethod = 'Cash';
  var curPayments = [], curPaymentsOrder = null;

  var brandFor = function (c) { return BRAND_COLORS[c] || DEFAULT_BRAND; };
  var modeFor = function (c) { return priceMode[c] || 'normal'; };
  function priceFor(p) { var m = modeFor(p.category); return m === 'discount50k' ? p.discountPrice : m === 'discountN1' ? p.discountN1Price : p.salesPrice; }

  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.style.display = 'none'; }, 3500);
  }
  function friendly(m) {
    m = String(m || '');
    if (/BAD_LOGIN/.test(m)) return 'Wrong staff name or PIN.';
    if (/LOCKED/.test(m)) return 'Too many wrong PINs. Wait 10 minutes.';
    if (/BUSY/.test(m)) return 'Server busy. Try again in a minute.';
    if (/BAD_KEY|BAD_DEVICE/.test(m)) return 'App is not set up correctly (sync key).';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'No signal.';
    if (/HEADER_MISSING|LAYOUT|SHEET_MISSING/.test(m)) return 'Server setup problem. Call the owner.';
    return m;
  }

  /* ---------------- login ---------------- */
  var nameInput = $('nameInput'), pinInput = $('pinInput'), loginBtn = $('loginBtn'), loginError = $('loginError');
  function loginBusy(b) { loginBtn.disabled = b; loginBtn.textContent = b ? 'Checking…' : 'Sign in'; }

  function attemptLogin() {
    var name = nameInput.value.trim(), pin = pinInput.value.trim();
    if (!name || !pin) return;
    loginBusy(true); loginError.textContent = '';
    OICpin.verifyOffline(name, pin).then(function (row) {
      if (row) return row;                                    // PIN checked on the phone
      if (!navigator.onLine) throw new Error('Wrong name or PIN, or this phone has not been signed in online yet. First sign-in needs a signal.');
      return OICsync.syncNow({ staff: name, pin: pin }).then(function () {
        return OICpin.verifyOffline(name, pin);
      }).then(function (r) { if (!r) throw new Error('BAD_LOGIN'); return r; });
    }).then(function (row) {
      session = { staff: row.name, pin: pin, role: row.role };
      return OICdb.put('meta', { key: 'lastStaff', value: row.name });
    }).then(function () {
      loginBusy(false); $('loginScreen').style.display = 'none'; $('app').style.display = 'block';
      $('repBadge').textContent = session.staff + ' (' + session.role + ')';
      pinInput.value = '';
      return loadData();
    }).then(function () { refreshSyncBar(); return trySync(false); })
      .catch(function (e) { loginBusy(false); loginError.textContent = friendly(e.message); pinInput.value = ''; });
  }
  loginBtn.onclick = attemptLogin;
  pinInput.onkeydown = nameInput.onkeydown = function (e) { if (e.key === 'Enter') attemptLogin(); };

  $('logoutBtn').onclick = function () {
    if (!confirm('Log out? Quantities not yet saved on this order will be cleared.')) return;
    session = null; Object.keys(qty).forEach(function (k) { qty[k] = 0; }); Object.keys(priceMode).forEach(function (k) { delete priceMode[k]; });
    $('app').style.display = 'none'; $('reportScreen').style.display = 'none'; $('loginScreen').style.display = 'flex';
    $('repBadge').textContent = '\u2014'; pinInput.value = ''; loginError.textContent = ''; pinInput.focus();
  };

  function prepareLogin() {
    OICdb.get('meta', 'lastStaff').then(function (r) { if (r && !nameInput.value) nameInput.value = r.value; });
    OICdb.getAll('staff').then(function (list) {
      $('staffNames').innerHTML = list.map(function (s) { return '<option value="' + esc(s.name) + '">'; }).join('');
    });
  }

  /* ---------------- data from the phone's notebook ---------------- */
  function toProducts(rows) {
    return rows.filter(function (r) { var a = String(r['Active'] || '').toLowerCase(); return a !== 'no' && a !== 'inactive'; })
      .map(function (r) {
        var p = Number(r['Price']) || 0, code = String(r['Item Code'] || r.k);
        return { id: code, name: String(r['Item Name'] || code), category: String(r['Category'] || 'OTHER').toUpperCase(),
                 salesPrice: p, discountPrice: round2(p * 0.995), discountN1Price: round2(p * 0.99) };
      }).filter(function (p) { return p.salesPrice > 0; })
      .sort(function (a, b) {                       // networks in the usual order, then by price
        var order = Object.keys(BRAND_COLORS), ra = order.indexOf(a.category), rb = order.indexOf(b.category);
        ra = ra < 0 ? 99 : ra; rb = rb < 0 ? 99 : rb;
        return ra - rb || a.category.localeCompare(b.category) || a.salesPrice - b.salesPrice || a.name.localeCompare(b.name);
      });
  }
  function loadData() {
    return Promise.all([OICdb.getAll('items'), OICdb.getAll('customers')]).then(function (r) {
      PRODUCTS = toProducts(r[0]);
      CATEGORIES = PRODUCTS.map(function (p) { return p.category; }).filter(function (c, i, a) { return a.indexOf(c) === i; });
      if (CATEGORIES.indexOf(activeCategory) < 0) activeCategory = CATEGORIES[0] || null;
      var keep = custSelect.value;
      initCustomers(r[1]);
      if (keep && keep !== '__new') custSelect.value = keep;
      renderTabs(); renderPriceToggle(); renderList(searchInput.value); updateTotals();
    });
  }

  var custSelect = $('custSelect'), custGsm = $('custGsm');
  function initCustomers(rows) {
    var server = {}, list = [];
    rows.forEach(function (c) { if (!c.local) { var n = String(c.Name || '').trim(); if (n) { server[n.toLowerCase()] = true; list.push({ name: n, gsm: String(c.Phone || '') }); } } });
    rows.forEach(function (c) { if (c.local) { var n = String(c.Name || '').trim(); if (n && !server[n.toLowerCase()]) list.push({ name: n, gsm: String(c.Phone || '') }); } });
    list.sort(function (a, b) { return a.name.localeCompare(b.name); });
    customers = list;
    custSelect.innerHTML = '<option value="">Walk-in (no account)</option>';
    list.forEach(function (c) { var o = document.createElement('option'); o.value = c.name; o.textContent = c.name; o.dataset.gsm = c.gsm; custSelect.appendChild(o); });
    var a = document.createElement('option'); a.value = '__new'; a.textContent = '+ Add new customer'; custSelect.appendChild(a);
  }

  /* ---------------- product screen (as in the demo) ---------------- */
  var tabsEl = $('tabs'), listEl = $('productList'), searchInput = $('searchInput');
  function renderTabs() {
    tabsEl.innerHTML = '';
    CATEGORIES.forEach(function (cat) {
      var b = brandFor(cat);
      var count = PRODUCTS.filter(function (p) { return p.category === cat && (qty[p.id] || 0) > 0; }).reduce(function (s, p) { return s + qty[p.id]; }, 0);
      var btn = document.createElement('div'); btn.className = 'tab-btn'; btn.textContent = cat;
      if (count > 0) { var c = document.createElement('span'); c.className = 'tab-count'; c.textContent = '(' + count + ')'; btn.appendChild(c); }
      if (cat === activeCategory) { btn.style.background = b.main; btn.style.color = b.text; btn.style.borderColor = b.main; } else btn.style.borderColor = b.main + '55';
      btn.onclick = function () { activeCategory = cat; searchInput.value = ''; renderTabs(); renderPriceToggle(); renderList(); };
      tabsEl.appendChild(btn);
    });
  }
  var pBtns = { normal: $('normalPriceBtn'), discount50k: $('discount50kBtn'), discountN1: $('discountN1Btn') };
  function renderPriceToggle() { var m = modeFor(activeCategory); Object.keys(pBtns).forEach(function (k) { pBtns[k].classList.toggle('active', m === k); }); }
  Object.keys(pBtns).forEach(function (k) { pBtns[k].onclick = function () { priceMode[activeCategory] = k; renderPriceToggle(); updateTotals(); }; });

  function renderList(filter) {
    filter = filter || '';
    if (!activeCategory) { listEl.innerHTML = '<div class="status-msg">No products yet. Connect to the internet and sign in to download the price list.</div>'; return; }
    var term = filter.trim().toLowerCase();
    var items = PRODUCTS.filter(function (p) { return p.category === activeCategory && p.name.toLowerCase().indexOf(term) >= 0; });
    listEl.innerHTML = '';
    if (!items.length) { listEl.innerHTML = '<div class="status-msg">No products match your search.</div>'; return; }
    var b = brandFor(activeCategory), m = modeFor(activeCategory);
    items.forEach(function (p) {
      var q = qty[p.id] || 0, u = priceFor(p), row = document.createElement('div');
      row.className = 'product-row' + (q > 0 ? ' active' : ''); row.style.borderLeftColor = b.main;
      row.innerHTML = '<div><div class="product-name">' + esc(p.name) + '</div><div class="product-price">' + formatMoney(u) + ' / unit' + (m !== 'normal' ? '<span class="discount-tag">' + PML[m] + '</span>' : '') + '</div></div>' +
        '<div class="qty-control"><div class="qty-btn" data-action="dec" data-id="' + esc(p.id) + '">\u2013</div><input class="qty-input" type="number" min="0" inputmode="numeric" value="' + q + '" data-id="' + esc(p.id) + '"><div class="qty-btn plus" style="background:' + b.main + ';color:' + b.text + '" data-action="inc" data-id="' + esc(p.id) + '">+</div></div>' +
        '<div class="line-total">' + (q > 0 ? formatMoney(u * q) : '') + '</div>';
      listEl.appendChild(row);
    });
  }
  function updateQty(id, n) { qty[id] = Math.max(0, Math.floor(Number(n)) || 0); updateTotals(); }
  function updateTotals() {
    var c = 0, t = 0;
    Object.keys(qty).forEach(function (id) { var q = qty[id]; if (q > 0) { var p = PRODUCTS.filter(function (x) { return x.id === id; })[0]; if (p) { c += q; t += priceFor(p) * q; } } });
    $('itemCount').textContent = c + (c === 1 ? ' item' : ' items'); $('runningTotal').textContent = formatMoney(t); $('generateBtn').disabled = t <= 0;
    renderTabs(); renderList(searchInput.value);
  }
  listEl.onclick = function (e) { var b = e.target.closest('.qty-btn'); if (!b) return; updateQty(b.dataset.id, (qty[b.dataset.id] || 0) + (b.dataset.action === 'inc' ? 1 : -1)); };
  listEl.onkeydown = function (e) {
    if (e.target.classList.contains('qty-input') && e.key === 'Enter') {
      e.preventDefault();
      var idx = Array.prototype.indexOf.call(listEl.querySelectorAll('.qty-input'), e.target); updateQty(e.target.dataset.id, e.target.value);
      var a = listEl.querySelectorAll('.qty-input'), n = a[idx + 1] || a[0]; if (n) { n.focus(); n.select(); }
    }
  };
  listEl.onchange = function (e) { if (e.target.classList.contains('qty-input')) updateQty(e.target.dataset.id, e.target.value); };
  searchInput.oninput = function () { renderList(searchInput.value); };

  /* ---------------- customers ---------------- */
  var ncRow = $('newCustomerRow'), ncIn = $('newCustomerInput'), ncGsm = $('newCustomerGsm');
  custSelect.onchange = function () {
    if (custSelect.value === '__new') { ncRow.classList.add('show'); custGsm.textContent = ''; ncIn.focus(); }
    else { ncRow.classList.remove('show'); var o = custSelect.selectedOptions[0]; custGsm.textContent = o && o.dataset.gsm ? 'GSM: ' + o.dataset.gsm : ''; }
  };
  $('addCustomerBtn').onclick = function () {
    var name = cleanText(ncIn.value), gsm = ncGsm.value.replace(/[^0-9+]/g, '');
    if (!name) return;
    OICdb.put('customers', { k: 'local:' + name.toLowerCase(), Name: name, Phone: gsm, local: true })
      .then(function () { return OICdb.getAll('customers'); })
      .then(function (rows) { initCustomers(rows); custSelect.value = name; custGsm.textContent = gsm ? 'GSM: ' + gsm : ''; ncRow.classList.remove('show'); ncIn.value = ''; ncGsm.value = ''; });
  };
  function curCustomer() {
    var v = custSelect.value; if (!v || v === '__new') return { name: 'Walk-in', gsm: '', walkin: true };
    var o = custSelect.selectedOptions[0]; return { name: v, gsm: o && o.dataset.gsm ? o.dataset.gsm : '', walkin: false };
  }

  /* ---------------- invoice and payment choice ---------------- */
  var modal = $('modalOverlay'), payFields = $('payFields'), payAmount = $('payAmount'), payRef = $('payRef');
  function chipsOn(container, attr, val) { Array.prototype.forEach.call(container.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute(attr) === val); }); }

  $('generateBtn').onclick = function () {
    var c = curCustomer(), date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    $('invoiceMeta').innerHTML = 'Rep: ' + esc(session.staff) + ' &nbsp;\u00b7&nbsp; Customer: ' + esc(c.name) + ' &nbsp;\u00b7&nbsp; ' + date;
    var L = $('invoiceLines'); L.innerHTML = ''; var items = [], total = 0;
    PRODUCTS.forEach(function (p) {
      var q = qty[p.id] || 0; if (q > 0) {
        var u = priceFor(p), lt = round2(u * q), m = modeFor(p.category); total += lt;
        items.push({ code: p.id, name: p.name, category: p.category, priceMode: m, price: u, qty: q, lineTotal: lt });
        var r = document.createElement('div'); r.className = 'invoice-line';
        r.innerHTML = '<div><div>' + esc(p.name) + (m !== 'normal' ? ' <span style="color:#A9822F;font-size:.75rem">(' + PML[m] + ')</span>' : '') + '</div><div class="calc">' + q + ' \u00d7 ' + formatMoney(u) + '</div></div><div class="amt">' + formatMoney(lt) + '</div>';
        L.appendChild(r);
      }
    });
    total = round2(total);
    inv = { items: items, total: total, customer: c };
    $('invoiceTotal').textContent = formatMoney(total);
    payChoice = null; payMethod = 'Cash'; payRef.value = ''; payAmount.value = '';
    chipsOn($('payChoice'), 'data-pay', null); chipsOn($('payMethod'), 'data-m', 'Cash');
    Array.prototype.forEach.call($('payChoice').querySelectorAll('button'), function (b) { b.disabled = c.walkin && b.dataset.pay !== 'full'; });
    $('payNote').textContent = c.walkin ? 'Walk-in customers must pay in full. Choose a customer to sell on credit.' : '';
    updatePayUI(); modal.classList.add('open');
  };
  $('closeModalBtn').onclick = function () { modal.classList.remove('open'); };

  $('payChoice').onclick = function (e) {
    var b = e.target.closest('button'); if (!b || b.disabled) return;
    payChoice = b.dataset.pay; chipsOn($('payChoice'), 'data-pay', payChoice);
    if (payChoice === 'full') payAmount.value = inv.total; else if (payChoice === 'credit') payAmount.value = 0; else payAmount.value = '';
    updatePayUI();
  };
  $('payMethod').onclick = function (e) { var b = e.target.closest('button'); if (!b) return; payMethod = b.dataset.m; chipsOn($('payMethod'), 'data-m', payMethod); updatePayUI(); };
  payAmount.oninput = updatePayUI;

  function payNow() {
    if (!inv || !payChoice) return 0;
    if (payChoice === 'full') return inv.total;
    if (payChoice === 'credit') return 0;
    return round2(Number(payAmount.value) || 0);
  }
  function updatePayUI() {
    var amt = payNow();
    payFields.style.display = payChoice && payChoice !== 'credit' ? 'block' : 'none';
    $('payAmountRow').style.display = payChoice === 'part' ? 'block' : 'none';
    $('payRefRow').style.display = payChoice && payChoice !== 'credit' && payMethod !== 'Cash' ? 'block' : 'none';
    var ok = !!payChoice;
    if (payChoice === 'part') ok = amt > 0 && amt < inv.total;
    $('paySummary').textContent = payChoice ? 'Pay now ' + formatMoney(amt) + '  \u00b7  Balance owed ' + formatMoney(round2(inv.total - amt)) : '';
    if (payChoice === 'part' && !ok && payAmount.value !== '') $('payNote').textContent = 'Part payment must be more than 0 and less than the total.';
    else if (!inv.customer.walkin) $('payNote').textContent = '';
    $('confirmBtn').disabled = !ok;
  }

  $('confirmBtn').onclick = function () {
    var amt = payNow(), ref = payRef.value.trim(), btn = $('confirmBtn');
    if (amt > 0 && payMethod !== 'Cash' && !ref) { alert('Enter the reference for a ' + payMethod + ' payment.'); payRef.focus(); return; }
    btn.disabled = true; btn.textContent = 'Saving\u2026';
    var order;
    OICstore.saveOrder(session, { customer: inv.customer.name, gsm: inv.customer.gsm, total: inv.total, items: inv.items }).then(function (o) {
      order = o;
      if (amt <= 0) return null;
      return OICstore.savePayment(session, { orderId: o.orderId, method: payMethod, amount: amt, reference: ref });
    }).then(function () {
      modal.classList.remove('open'); btn.textContent = 'Confirm & save';
      toast('Saved on this phone. Syncs when there is a signal.');
      var receipt = { orderId: order.orderId, dateTime: order.dateTime, rep: order.rep, customer: order.customer, items: inv.items, total: inv.total, paid: amt, balance: round2(inv.total - amt) };
      Object.keys(qty).forEach(function (k) { qty[k] = 0; }); updateTotals(); refreshSyncBar();
      if (confirm('Print receipt now?')) printHtml(receiptInvoice(receipt));
      trySync(false);
    }).catch(function (e) { alert('Could not save: ' + e.message); btn.disabled = false; btn.textContent = 'Confirm & save'; });
  };

  /* ---------------- receipts (58mm) ---------------- */
  function printHtml(html) { $('receipt').innerHTML = html; setTimeout(function () { window.print(); }, 150); }
  function rcHead(title) {
    return '<div class="rc-c"><img src="logo.jpg" alt=""><div class="rc-b">Auwal Jogana Communication</div><div>' + title + '</div></div><div class="rc-h"></div>';
  }
  function nowLabel(iso) { var d = iso ? new Date(iso) : new Date(); return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function receiptInvoice(d) {
    var lines = (d.items || []).map(function (it) {
      return '<div class="rc-i">' + esc(it.name) + (it.priceMode && it.priceMode !== 'normal' ? ' (' + PML[it.priceMode] + ')' : '') + '</div><div class="rc-r"><span>' + it.qty + ' \u00d7 ' + formatMoney(it.price) + '</span><span>' + formatMoney(it.lineTotal) + '</span></div>';
    }).join('');
    return rcHead('Invoice') + '<div>Date: ' + nowLabel(d.dateTime) + '</div><div>Order: ' + esc(d.orderId) + '</div><div>Rep: ' + esc(d.rep) + '</div><div>Customer: ' + esc(d.customer) + '</div><div class="rc-h"></div>' + lines +
      '<div class="rc-h"></div><div class="rc-r rc-t"><span>TOTAL</span><span>' + formatMoney(d.total) + '</span></div><div class="rc-r"><span>Paid now</span><span>' + formatMoney(d.paid) + '</span></div><div class="rc-r rc-t"><span>BALANCE</span><span>' + formatMoney(d.balance) + '</span></div>' +
      '<div class="rc-h"></div><div class="rc-c">Thank you for your patronage</div>';
  }
  function receiptPayment(d) {
    return rcHead('Payment receipt') + '<div>Date: ' + nowLabel(d.dateTime) + '</div><div>Order: ' + esc(d.orderId) + '</div><div>Payment: ' + esc(d.paymentId) + '</div><div>Rep: ' + esc(d.rep) + '</div><div>Customer: ' + esc(d.customer) + '</div><div class="rc-h"></div>' +
      '<div class="rc-r rc-t"><span>PAID</span><span>' + formatMoney(d.amount) + '</span></div><div class="rc-r"><span>Method</span><span>' + esc(d.method) + '</span></div>' + (d.reference ? '<div>Ref: ' + esc(d.reference) + '</div>' : '') +
      '<div class="rc-h"></div><div class="rc-r rc-t"><span>BALANCE</span><span>' + formatMoney(d.balance) + '</span></div><div class="rc-s">(balance as of last sync)</div><div class="rc-h"></div><div class="rc-c">Thank you</div>';
  }

  /* ---------------- order report ---------------- */
  var rs = $('reportScreen'), ol = $('ordersList');
  $('openReportBtn').onclick = function () { rs.style.display = 'block'; renderReport(); };
  $('closeReportBtn').onclick = function () { rs.style.display = 'none'; };
  $('fAll').onclick = function () { reportFilter = 'all'; $('fAll').classList.add('active'); $('fOwing').classList.remove('active'); renderReport(); };
  $('fOwing').onclick = function () { reportFilter = 'owing'; $('fOwing').classList.add('active'); $('fAll').classList.remove('active'); renderReport(); };
  $('rptSearch').oninput = function () { renderReport(); };

  function payBadge(total, bal, status) {
    if (status === 'Deleted') return '<span class="badge b-rejected">Deleted</span>';
    if (bal < -0.005) return '<span class="badge b-over">Overpaid</span>';
    if (bal <= 0.005) return '<span class="badge b-paid">Paid</span>';
    return bal < total - 0.005 ? '<span class="badge b-part">Part paid</span>' : '<span class="badge b-owe">Owing</span>';
  }
  function syncBadge(rec) {
    if (!rec) return '<span class="badge b-synced">Synced</span>';
    return '<span class="badge b-' + rec.sync.toLowerCase() + '">' + rec.sync + '</span>';
  }
  function canDelete(e) {
    if (e.status === 'Deleted') return false;
    if (session.role === 'Owner') return true;
    return !!e.rec && e.rec.sync === 'Pending' && e.rec.rep === session.staff;   // a rep: only an order never synced
  }

  function renderReport() {
    ol.innerHTML = '<div class="status-msg">Loading\u2026</div>';
    Promise.all([OICdb.getAll('orders'), OICdb.getAll('openInvoices')]).then(function (r) {
      var entries = [], seen = {};
      r[0].forEach(function (o) {
        if (o.stub) return;
        seen[o.orderId] = true;
        entries.push({ orderId: o.orderId, dateTime: o.dateTime, rep: o.rep, customer: o.customer, gsm: o.gsm, total: o.total, items: o.items, status: o.status || 'Active', rec: o });
      });
      r[1].forEach(function (o) { if (!seen[o.orderId]) entries.push({ orderId: o.orderId, dateTime: o.dateTime, rep: o.rep, customer: o.customer, gsm: o.gsm, total: o.total, items: null, status: 'Active', rec: null }); });
      entries = entries.filter(function (e) { return e.status !== 'Deleted' || (e.rec && e.rec.sync === 'Rejected'); });
      entries.sort(function (a, b) { return String(b.dateTime).localeCompare(String(a.dateTime)); });
      return Promise.all(entries.map(function (e) { return OICstore.localBalance(e.orderId).then(function (b) { e.balance = b; return e; }); }));
    }).then(function (entries) {
      var term = $('rptSearch').value.trim().toLowerCase();
      entries = entries.filter(function (e) {
        if (reportFilter === 'owing' && !(e.balance > 0.005)) return false;
        return !term || String(e.customer).toLowerCase().indexOf(term) >= 0 || String(e.orderId).toLowerCase().indexOf(term) >= 0;
      });
      if (!entries.length) { ol.innerHTML = '<div class="status-msg">' + (reportFilter === 'owing' ? 'No customer owes anything.' : 'No orders yet. Save an order and it will appear here.') + '</div>'; return; }
      ol.innerHTML = entries.map(cardHtml).join('');
    });
  }
  function cardHtml(e) {
    var lab = nowLabel(e.dateTime), paid = round2(e.total - e.balance);
    var ih = (e.items || []).map(function (it) { return '<div class="order-item-line"><span>' + esc(it.name) + ' \u00d7 ' + it.qty + (it.priceMode && it.priceMode !== 'normal' ? ' (' + PML[it.priceMode] + ')' : '') + '</span><span>' + formatMoney(it.lineTotal) + '</span></div>'; }).join('');
    var acts = '';
    if (e.balance > 0.005 && e.status !== 'Deleted') acts += '<button class="primary" data-act="collect" data-id="' + esc(e.orderId) + '">Collect payment</button>';
    acts += '<button data-act="pays" data-id="' + esc(e.orderId) + '">Payments</button>';
    if (e.items && e.status !== 'Deleted') acts += '<button data-act="print" data-id="' + esc(e.orderId) + '">Print</button>';
    if (canDelete(e)) acts += '<button class="danger" data-act="del" data-id="' + esc(e.orderId) + '">Delete</button>';
    return '<div class="order-card"><div class="order-card-top"><div><div class="order-datetime">' + lab + syncBadge(e.rec) + payBadge(e.total, e.balance, e.status) + '</div><div class="order-rep-cust">Rep: ' + esc(e.rep || '\u2014') + ' \u00b7 Customer: ' + esc(e.customer || '\u2014') + (e.gsm ? ' (' + esc(e.gsm) + ')' : '') + '</div></div><div class="order-id">' + esc(e.orderId) + '</div></div>' +
      (ih ? '<div class="order-items">' + ih + '</div>' : '') +
      '<div class="order-total-row"><span>Total</span><span>' + formatMoney(e.total) + '</span></div><div class="order-sub-row"><span>Paid</span><span>' + formatMoney(paid) + '</span></div><div class="order-sub-row"><span>Balance <span style="font-weight:400;color:var(--soft)">(as of last sync)</span></span><span>' + formatMoney(e.balance) + '</span></div>' +
      (e.rec && e.rec.error ? '<div class="err-line">' + esc(e.rec.error) + '</div>' : '') +
      '<div class="card-actions">' + acts + '</div></div>';
  }

  ol.onclick = function (e) {
    var b = e.target.closest('button[data-act]'); if (!b) return;
    var id = b.dataset.id, act = b.dataset.act;
    if (act === 'collect') openCollect(id);
    else if (act === 'pays') openPayments(id);
    else if (act === 'print') printOrder(id);
    else if (act === 'del') doDelete(id);
  };

  function printOrder(id) {
    Promise.all([OICdb.get('orders', id), OICstore.localBalance(id)]).then(function (r) {
      var o = r[0]; if (!o) return;
      printHtml(receiptInvoice({ orderId: o.orderId, dateTime: o.dateTime, rep: o.rep, customer: o.customer, items: o.items, total: o.total, paid: round2(o.total - r[1]), balance: r[1] }));
    });
  }
  function doDelete(id) {
    var reason = (prompt('Why is this order being deleted?') || '').trim();
    if (!reason) return;
    if (!confirm('Delete this order? The row stays in the books marked Deleted, with your reason.')) return;
    OICdb.get('orders', id).then(function (rec) {
      return OICstore.deleteOrder(session, id, reason, rec ? rec.customer : '');
    }).then(function () { renderReport(); refreshSyncBar(); trySync(false); });
  }

  /* ---------------- collect payment ---------------- */
  var collectModal = $('collectModal');
  function openCollect(id) {
    Promise.all([OICdb.get('orders', id), OICdb.get('openInvoices', id), OICstore.localBalance(id)]).then(function (r) {
      var o = r[0] || r[1]; if (!o) return;
      collectFor = { orderId: id, customer: o.customer, balance: r[2] }; cMethod = 'Cash';
      chipsOn($('cMethod'), 'data-m', 'Cash'); $('cRefRow').style.display = 'none'; $('cRef').value = ''; $('cAmount').value = r[2]; $('cNote').textContent = '';
      $('cInfo').innerHTML = 'Customer: ' + esc(o.customer) + '<br>Invoice: ' + esc(id) + '<br>Balance on this phone: <b>' + formatMoney(r[2]) + '</b> (as of last sync)';
      collectModal.classList.add('open');
    });
  }
  $('cMethod').onclick = function (e) { var b = e.target.closest('button'); if (!b) return; cMethod = b.dataset.m; chipsOn($('cMethod'), 'data-m', cMethod); $('cRefRow').style.display = cMethod === 'Cash' ? 'none' : 'block'; };
  $('cCancel').onclick = function () { collectModal.classList.remove('open'); };
  $('cSave').onclick = function () {
    var amt = round2(Number($('cAmount').value) || 0), ref = $('cRef').value.trim();
    if (!(amt > 0)) { $('cNote').textContent = 'Enter the amount received.'; return; }
    if (cMethod !== 'Cash' && !ref) { $('cNote').textContent = 'A ' + cMethod + ' payment needs a reference.'; return; }
    if (amt > collectFor.balance + 0.005 && !confirm('This is more than the balance (' + formatMoney(collectFor.balance) + '). Save anyway? Another rep may have collected too.')) return;
    var btn = $('cSave'); btn.disabled = true;
    OICstore.savePayment(session, { orderId: collectFor.orderId, method: cMethod, amount: amt, reference: ref }).then(function (p) {
      return OICstore.localBalance(collectFor.orderId).then(function (nb) {
        collectModal.classList.remove('open'); btn.disabled = false;
        toast('Payment saved on this phone.'); renderReport(); refreshSyncBar();
        if (confirm('Print payment receipt now?')) printHtml(receiptPayment({ orderId: p.orderId, paymentId: p.paymentId, dateTime: p.dateTime, rep: p.rep, customer: collectFor.customer, amount: amt, method: cMethod, reference: ref, balance: nb }));
        trySync(false);
      });
    }).catch(function (e) { btn.disabled = false; alert('Could not save: ' + e.message); });
  };

  /* ---------------- payments list and reverse ---------------- */
  var pmModal = $('paymentsModal');
  function sameDay(iso) { return new Date(iso).toDateString() === new Date().toDateString(); }
  function openPayments(id) {
    curPaymentsOrder = id; $('pmList').innerHTML = '<div class="status-msg">Loading\u2026</div>'; $('pmInfo').textContent = 'Invoice: ' + id; pmModal.classList.add('open');
    var serverP = (session.role === 'Owner' && navigator.onLine) ? OICsync.getPayments(session, id).catch(function () { return null; }) : Promise.resolve(null);
    Promise.all([OICdb.getAll('payments'), serverP]).then(function (r) {
      var map = {}, order = [];
      (r[1] || []).forEach(function (p) { map[p.paymentId] = { paymentId: p.paymentId, orderId: id, dateTime: p.dateTime, rep: p.rep, method: p.method, amount: p.amount, reference: p.reference, type: p.type, reversalOf: p.reversalOf, serverReversed: !!p.reversed, sync: 'Synced', from: 'server' }; order.push(p.paymentId); });
      r[0].filter(function (p) { return p.orderId === id; }).forEach(function (p) {
        if (!map[p.paymentId]) order.push(p.paymentId);
        map[p.paymentId] = { paymentId: p.paymentId, orderId: id, dateTime: p.dateTime, rep: p.rep, method: p.method, amount: p.amount, reference: p.reference, type: p.type, reversalOf: p.reversalOf, reason: p.reason, sync: p.sync, error: p.error, serverReversed: (map[p.paymentId] || {}).serverReversed };
      });
      var rev = {}; order.forEach(function (k) { if (map[k].type === 'Reversal') rev[map[k].reversalOf] = true; });
      curPayments = order.map(function (k) { var p = map[k]; p.reversed = !!(rev[p.paymentId] || p.serverReversed); return p; });
      curPayments.sort(function (a, b) { return String(a.dateTime).localeCompare(String(b.dateTime)); });
      if (!curPayments.length) { $('pmList').innerHTML = '<div class="status-msg">No payments on this phone for this invoice.' + (session.role === 'Owner' && !navigator.onLine ? '<br>Connect to see payments from other phones.' : '') + '</div>'; return; }
      $('pmList').innerHTML = curPayments.map(function (p) {
        var isRev = p.type === 'Reversal', allowed = !isRev && !p.reversed && (session.role === 'Owner' || (p.rep === session.staff && sameDay(p.dateTime)));
        return '<div class="pay-row"><div><b>' + (isRev ? 'Reversal' : esc(p.method)) + '</b> ' + (p.reversed ? '<span class="badge b-rejected">Reversed</span>' : '') + '<span class="badge b-' + String(p.sync).toLowerCase() + '">' + esc(p.sync) + '</span><div class="sm">' + nowLabel(p.dateTime) + ' \u00b7 ' + esc(p.rep) + (p.reference ? ' \u00b7 Ref ' + esc(p.reference) : '') + (p.reason ? ' \u00b7 ' + esc(p.reason) : '') + '</div>' +
          (allowed ? '<button data-rev="' + esc(p.paymentId) + '">Reverse</button>' : '') + '</div><div><b>' + (isRev ? '\u2212' : '') + formatMoney(p.amount) + '</b></div></div>';
      }).join('');
    });
  }
  $('pmClose').onclick = function () { pmModal.classList.remove('open'); };
  $('pmList').onclick = function (e) {
    var b = e.target.closest('button[data-rev]'); if (!b) return;
    var p = curPayments.filter(function (x) { return x.paymentId === b.dataset.rev; })[0]; if (!p) return;
    var reason = (prompt('Why is this payment being reversed?') || '').trim(); if (!reason) return;
    if (!confirm('Reverse this payment? A reversal entry is added. It cannot be undone.')) return;
    OICstore.saveReversal(session, p, reason).then(function () { toast('Reversal saved on this phone.'); openPayments(curPaymentsOrder); renderReport(); refreshSyncBar(); trySync(false); });
  };

  /* ---------------- sync bar, needs attention ---------------- */
  function setSyncState(t) { $('syncState').textContent = t; }
  function refreshSyncBar() {
    var bar = $('syncBar'), on = navigator.onLine;
    bar.classList.toggle('off', !on);
    if (!syncing) setSyncState(on ? 'Online' : 'Offline');
    return Promise.all([OICdb.getAll('orders'), OICdb.getAll('payments'), OICdb.get('meta', 'lastSync')]).then(function (r) {
      var po = r[0].filter(function (x) { return x.sync === 'Pending'; }).length, pp = r[1].filter(function (x) { return x.sync === 'Pending'; }).length;
      var rej = r[0].concat(r[1]).filter(function (x) { return x.sync === 'Rejected'; }).length;
      $('syncPending').innerHTML = 'Pending: <b>' + po + '</b> orders, <b>' + pp + '</b> payments';
      $('syncLast').textContent = r[2] ? 'Last sync: ' + new Date(r[2].value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'Never synced';
      var a = $('attnBtn'); a.style.display = rej ? 'inline-block' : 'none'; a.textContent = 'Needs attention (' + rej + ')';
      return po + pp;
    });
  }
  window.addEventListener('online', function () { refreshSyncBar(); trySync(false); });
  window.addEventListener('offline', function () { refreshSyncBar(); });
  setInterval(function () { if (session && navigator.onLine && !syncing) refreshSyncBar().then(function (n) { if (n > 0) trySync(false); }); }, 60000);
  $('syncBtn').onclick = function () { trySync(true); };

  function trySync(manual) {
    if (!session || syncing) return Promise.resolve();
    if (!navigator.onLine) { if (manual) toast('No signal. Records stay safe on this phone.'); return Promise.resolve(); }
    syncing = true; setSyncState('Syncing\u2026');
    return OICsync.syncNow(session).then(function () {
      return OICdb.getAll('customers').then(function (rows) {            // remove local copies now that the server has them
        var server = {}; rows.forEach(function (c) { if (!c.local) server[String(c.Name || '').toLowerCase()] = true; });
        return Promise.all(rows.filter(function (c) { return c.local && server[String(c.Name || '').toLowerCase()]; }).map(function (c) { return OICdb.del('customers', c.k); }));
      }).then(loadData);
    }).then(function () { if (manual) toast('Synced.'); if (rs.style.display === 'block') renderReport(); })
      .catch(function (e) { toast('Sync failed: ' + friendly(e.message)); })
      .then(function () { syncing = false; return refreshSyncBar(); });
  }

  $('attnBtn').onclick = openAttention;
  $('attnClose').onclick = function () { $('attnModal').classList.remove('open'); };
  function openAttention() {
    Promise.all([OICdb.getAll('orders'), OICdb.getAll('payments')]).then(function (r) {
      var rows = [];
      r[0].filter(function (x) { return x.sync === 'Rejected'; }).forEach(function (o) { rows.push({ kind: 'order', id: o.orderId, title: o.status === 'Deleted' ? 'Delete request' : 'Order', who: o.customer, amount: o.total, error: o.error, rec: o }); });
      r[1].filter(function (x) { return x.sync === 'Rejected'; }).forEach(function (p) { rows.push({ kind: 'payment', id: p.paymentId, title: p.type, who: p.method, amount: p.amount, error: p.error, rec: p }); });
      $('attnList').innerHTML = rows.length ? rows.map(function (x) {
        return '<div class="pay-row"><div><b>' + esc(x.title) + '</b> \u00b7 ' + esc(x.who) + ' \u00b7 ' + (x.amount != null ? formatMoney(x.amount) : '') + '<div class="sm">' + esc(x.id) + '</div><div class="err-line">' + esc(x.error) + '</div>' +
          '<div class="card-actions"><button data-a="retry" data-k="' + x.kind + '" data-id="' + esc(x.id) + '">Retry</button><button class="danger" data-a="drop" data-k="' + x.kind + '" data-id="' + esc(x.id) + '">' + (x.rec.status === 'Deleted' ? 'Cancel delete' : 'Discard') + '</button></div></div></div>';
      }).join('') : '<div class="status-msg">Nothing needs attention.</div>';
      $('attnModal').classList.add('open');
    });
  }
  $('attnList').onclick = function (e) {
    var b = e.target.closest('button[data-a]'); if (!b) return;
    var store = b.dataset.k === 'order' ? 'orders' : 'payments';
    OICdb.get(store, b.dataset.id).then(function (rec) {
      if (!rec) return;
      if (b.dataset.a === 'retry') { rec.sync = 'Pending'; rec.error = ''; return OICdb.put(store, rec); }
      if (store === 'orders' && rec.status === 'Deleted') {                       // cancel a refused delete
        if (rec.stub) return OICdb.del(store, rec.orderId);
        rec.status = 'Active'; rec.reason = ''; rec.sync = rec.prevSync || 'Pending'; rec.error = ''; return OICdb.put(store, rec);
      }
      var warn = store === 'payments' ? 'The money was collected. Discarding means it will NOT be in the books. Write it down first. Discard?' : 'Discard this order? It will not be saved to the Sheet.';
      if (!confirm(warn)) return;
      return OICdb.del(store, b.dataset.id);
    }).then(function () { openAttention(); refreshSyncBar(); });
  };

  /* ---------------- start ---------------- */
  prepareLogin();
  refreshSyncBar().catch(function () {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  window.OIC_APP = { trySync: trySync, state: function () { return { session: session, PRODUCTS: PRODUCTS, customers: customers }; } };
})();
