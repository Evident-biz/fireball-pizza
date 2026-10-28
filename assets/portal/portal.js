// Customer order portal. Plain script, no build step, same style as the rest of the site.
//   /my-order/?id=FB-XXXX&t=<token>   one order: status, event details, payments, pay online, message us
//   /my-orders/                        email lookup, then /my-orders/?m=<token> lists every order

(function(){
  var toggle = document.getElementById('navToggle');
  if(toggle) toggle.addEventListener('click', function(){ document.getElementById('navLinks').classList.toggle('open'); });

  function esc(value){
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n){
    if(n === null || n === undefined || n === '') return '';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function dateLabel(iso, long){
    if(!iso) return '';
    var d = iso.length === 10 ? new Date(iso + 'T00:00:00') : new Date(iso);
    return d.toLocaleDateString('en-US', long ? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function getJson(url, options){
    return fetch(url, options).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if(!res.ok) throw new Error(data.error || 'Something went wrong. Please call us at (209) 222-8926.');
        return data;
      });
    });
  }
  function post(url, body){
    return getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  var params = new URLSearchParams(location.search);

  // ---------- single order ----------
  var orderRoot = document.getElementById('orderRoot');
  if(orderRoot){
    var id = params.get('id');
    var token = params.get('t');
    var watchingFocus = false;
    if(!id || !token){
      orderRoot.innerHTML = notFound("This link is missing part of the address. Use the button in your email, or look up your orders by email.");
    } else {
      load();
    }

    function load(){
      getJson('/api/portal/order?id=' + encodeURIComponent(id) + '&t=' + encodeURIComponent(token))
        .then(function(data){ render(data.order); })
        .catch(function(err){ orderRoot.innerHTML = notFound(err.message); });
    }

    function render(o){
      document.title = 'Order ' + o.id + ' | Fireball Pizza';
      var isCatering = o.type === 'catering';
      var html = '';
      html += '<p class="eyebrow">Order ' + esc(o.id) + '</p>';
      html += '<h1>' + (isCatering ? 'Your catering order' : 'Your message to us') + '</h1>';
      html += '<p class="portal-status"><span class="portal-pill portal-pill-' + esc(o.status) + '">' + esc(o.statusLabel) + '</span>' +
        (isCatering && o.event.date ? ' <span class="muted">for ' + esc(dateLabel(o.event.date, true)) + '</span>' : '') + '</p>';

      if(isCatering && o.timeline.length){
        html += '<ol class="portal-steps">' + o.timeline.map(function(step){
          return '<li class="' + (step.done ? 'done' : '') + '"><span class="dot" aria-hidden="true"></span><span>' + esc(step.label) +
            (step.at && step.label === 'Event day' ? '<br><small class="muted">' + esc(dateLabel(step.at)) + '</small>' : '') +
            '</span><span class="sr-only">' + (step.done ? ' (done)' : ' (not yet)') + '</span></li>';
        }).join('') + '</ol>';
      }

      if(o.amountDue && o.amountDue.amount > 0){
        html += '<section class="portal-card portal-pay">' +
          '<div><h2>' + (o.amountDue.kind === 'deposit' ? 'Deposit due' : 'Balance due') + '</h2>' +
          '<p class="portal-amount">' + esc(money(o.amountDue.amount)) + '</p>' +
          '<p class="muted small">' + (o.amountDue.kind === 'deposit' ? 'Your date is locked in once the deposit is paid.' : 'Pay any time before your event.') + ' Secure checkout by Square.</p></div>' +
          '<div><button class="btn btn-primary" id="payBtn" type="button">Pay ' + esc(money(o.amountDue.amount)) + '</button>' +
          '<p class="form-status" id="payStatus" role="status"></p></div>' +
          '</section>';
      }

      if(isCatering){
        html += '<div class="portal-grid">';
        html += '<section class="portal-card"><h2>Event details</h2><dl class="portal-facts">' +
          fact('Date', o.event.date ? dateLabel(o.event.date, true) : 'Not set yet') +
          fact('Start time', o.event.time || 'Not set yet') +
          fact('Address', o.event.address || 'Not set yet') +
          fact('Guests', o.event.guestCount || 'Not set yet') +
          (o.event.serviceStyle ? fact('Service', o.event.serviceStyle) : '') +
          '</dl></section>';

        html += '<section class="portal-card"><h2>Payments</h2><dl class="portal-facts">' +
          fact('Total', o.quote.total ? money(o.quote.total) : 'To be confirmed') +
          (o.quote.deposit ? fact('Deposit', money(o.quote.deposit)) : '') +
          fact('Paid so far', money(o.paid || 0)) +
          (o.balance !== null ? fact('Balance', money(o.balance)) : '') +
          '</dl>' +
          (o.payments.length ? '<ul class="portal-payments">' + o.payments.map(function(p){
            return '<li><span>' + esc(dateLabel(p.at.slice(0, 10))) + '</span><span>' + esc(money(p.amount)) + '</span></li>';
          }).join('') + '</ul>' : '') +
          '</section>';
        html += '</div>';

        if(o.quote.pricingSummary){
          html += '<details class="portal-card portal-breakdown"><summary>Quote breakdown</summary><ul>' +
            o.quote.pricingSummary.split('|').map(function(line){ return line.trim(); }).filter(Boolean).map(function(line){
              var i = line.indexOf(':');
              return i > -1 ? '<li><span>' + esc(line.slice(0, i)) + '</span><span>' + esc(line.slice(i + 1).trim()) + '</span></li>' : '<li><span>' + esc(line) + '</span></li>';
            }).join('') + '</ul>' +
            (o.quote.extras ? '<p class="muted small">' + esc(o.quote.extras.split('|').join(' · ')) + '</p>' : '') +
            '<p class="muted small">Final pricing is confirmed by our team. Questions? Send us a message below.</p></details>';
        }
      }

      if(o.customerMessages.length){
        html += '<section class="portal-card"><h2>Your messages</h2><ul class="portal-messages">' + o.customerMessages.slice().reverse().map(function(m){
          return '<li><small class="muted">' + esc(new Date(m.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + '</small><p>' + esc(m.text) + '</p></li>';
        }).join('') + '</ul><p class="muted small">We reply by email or phone.</p></section>';
      }

      if(o.canRequestChange){
        html += '<section class="portal-card"><h2>' + (isCatering ? 'Need to change something?' : 'Add to your message') + '</h2>' +
          '<p class="muted">' + (isCatering ? 'Guest count, time, menu, address, anything. Send it here and we will confirm with you.' : 'Send us more details and we will get back to you.') + '</p>' +
          '<form id="msgForm" novalidate><div class="field"><label for="msgText">Message</label><textarea id="msgText" name="message" rows="4" required></textarea></div>' +
          '<button class="btn btn-primary" type="submit">Send to Fireball</button><p class="form-status" id="msgStatus" role="status"></p></form></section>';
      }

      html += '<p class="muted small portal-private">This page is private to you. Anyone with this link can see it, so don\'t post it publicly. <a href="/my-orders/">See all my orders</a></p>';
      orderRoot.innerHTML = html;
      bind(o);
    }

    function bind(o){
      var payBtn = document.getElementById('payBtn');
      if(payBtn){
        payBtn.addEventListener('click', function(){
          var status = document.getElementById('payStatus');
          payBtn.disabled = true;
          status.className = 'form-status show';
          status.textContent = 'Opening secure checkout…';
          // Open the tab right away so pop-up blockers allow it, then point it at Square.
          var win = window.open('', '_blank');
          post('/api/portal/order/pay', { id: o.id, t: token })
            .then(function(data){
              if(win){
                win.location = data.url;
                status.textContent = "Checkout opened in a new tab. Once you've paid, come back here and this page will update.";
                // Square tells us about the payment within a few seconds; re-check whenever they return to this tab.
                if(!watchingFocus){ watchingFocus = true; window.addEventListener('focus', function(){ setTimeout(load, 1500); }); }
              }
              else { location.href = data.url; }
            })
            .catch(function(err){
              if(win) win.close();
              status.className = 'form-status show err';
              status.textContent = err.message;
            })
            .then(function(){ payBtn.disabled = false; });
        });
      }
      var form = document.getElementById('msgForm');
      if(form){
        form.addEventListener('submit', function(e){
          e.preventDefault();
          var text = form.message.value.trim();
          var status = document.getElementById('msgStatus');
          status.className = 'form-status show';
          if(text.length < 2){ status.className = 'form-status show err'; status.textContent = 'Please type a message.'; return; }
          var btn = form.querySelector('button');
          btn.disabled = true;
          status.textContent = 'Sending…';
          post('/api/portal/order/message', { id: o.id, t: token, message: text })
            .then(function(data){ render(data.order); var s = document.getElementById('msgStatus'); if(s){ s.className = 'form-status show ok'; s.textContent = "Sent. We'll get back to you soon."; } })
            .catch(function(err){ status.className = 'form-status show err'; status.textContent = err.message; btn.disabled = false; });
        });
      }
    }
  }

  function fact(label, value){
    return '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }
  function notFound(message){
    return '<section class="portal-card"><h1>Order not found</h1><p>' + esc(message) + '</p><p><a class="btn btn-primary" href="/my-orders/">Look up my orders</a></p></section>';
  }

  // ---------- all orders for an email ----------
  var ordersRoot = document.getElementById('ordersRoot');
  if(ordersRoot){
    var lookupCard = document.getElementById('lookupCard');
    var magic = params.get('m');
    if(magic){
      ordersRoot.innerHTML = '<p class="muted">Loading your orders…</p>';
      getJson('/api/portal/orders?m=' + encodeURIComponent(magic))
        .then(function(data){
          if(!data.orders.length){ ordersRoot.innerHTML = '<p>No orders found for ' + esc(data.email) + '.</p>'; return; }
          ordersRoot.innerHTML = '<p class="muted">Orders for ' + esc(data.email) + '</p><ul class="portal-order-list">' + data.orders.map(function(o){
            return '<li><a class="portal-card portal-order-link" href="' + esc(o.portalUrl.replace(/^https?:\/\/[^/]+/, '')) + '">' +
              '<div><strong>' + (o.type === 'catering' ? (o.event.date ? esc(dateLabel(o.event.date, true)) : 'Catering, date to be set') : 'Message to Fireball') + '</strong>' +
              '<span class="muted small">' + esc(o.id) + (o.event.guestCount ? ' · ' + esc(o.event.guestCount) + ' guests' : '') + (o.quote.total ? ' · ' + esc(money(o.quote.total)) : '') + '</span></div>' +
              '<span class="portal-pill portal-pill-' + esc(o.status) + '">' + esc(o.statusLabel) + '</span></a></li>';
          }).join('') + '</ul>';
        })
        .catch(function(err){
          ordersRoot.innerHTML = '<p class="form-status show err">' + esc(err.message) + '</p>';
          lookupCard.hidden = false;
        });
    } else {
      lookupCard.hidden = false;
    }

    document.getElementById('lookupForm').addEventListener('submit', function(e){
      e.preventDefault();
      var form = e.target;
      var status = document.getElementById('lookupStatus');
      var email = form.email.value.trim();
      status.className = 'form-status show';
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ status.className = 'form-status show err'; status.textContent = 'Please enter a valid email address.'; return; }
      var btn = form.querySelector('button');
      btn.disabled = true;
      status.textContent = 'Sending…';
      post('/api/portal/lookup', { email: email })
        .then(function(data){ status.className = 'form-status show ok'; status.textContent = data.message; })
        .catch(function(err){ status.className = 'form-status show err'; status.textContent = err.message; })
        .then(function(){ btn.disabled = false; });
    });
  }
})();
