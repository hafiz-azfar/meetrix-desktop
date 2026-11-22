const form = document.querySelector('form');
const input = document.querySelector('#server');
const local = document.querySelector('#local');
const notice = document.querySelector('#notice');
const connect = form.querySelector('button');

window.meetrix.settings().then(info => {
  input.value = info.server || '';
  local.hidden = !info.local;
  notice.textContent = info.notice || '';
}).catch(() => { notice.textContent = 'Could not read workspace settings.'; });

async function open(value) {
  notice.textContent = 'Connecting…';
  connect.disabled = true;
  local.disabled = true;
  try {
    const result = await window.meetrix.connect(value);
    notice.textContent = result.error || 'Connected.';
  } catch { notice.textContent = 'The connection could not be completed.'; }
  finally { connect.disabled = false; local.disabled = false; }
}
form.addEventListener('submit', event => { event.preventDefault(); open(input.value); });
local.addEventListener('click', () => open('local'));
