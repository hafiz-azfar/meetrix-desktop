const form = document.querySelector('#host-form');
const insforgeForm = document.querySelector('#insforge-form');
const projectUrl = document.querySelector('#insforge-url');
const publicKey = document.querySelector('#insforge-key');
const input = document.querySelector('#server');
const local = document.querySelector('#local');
const notice = document.querySelector('#notice');
const buttons = document.querySelectorAll('button');

window.meetrix.settings().then(info => {
  input.value = info.server || '';
  local.hidden = !info.local;
  insforgeForm.hidden = info.local;
  notice.textContent = info.notice || '';
}).catch(() => { notice.textContent = 'Could not read workspace settings.'; });

async function open(action) {
  notice.textContent = 'Connecting…';
  buttons.forEach(button => { button.disabled = true; });
  try {
    const result = await action();
    notice.textContent = result.error || 'Connected.';
  } catch { notice.textContent = 'The connection could not be completed.'; }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}
form.addEventListener('submit', event => { event.preventDefault(); open(() => window.meetrix.connect(input.value)); });
insforgeForm.addEventListener('submit', event => {
  event.preventDefault();
  open(() => window.meetrix.configureInsForge(projectUrl.value, publicKey.value));
});
local.addEventListener('click', () => open(() => window.meetrix.connect('local')));
