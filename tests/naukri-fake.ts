import type { BrowserContext } from 'playwright';

// A stand-in for Naukri's job pages, served through Playwright routing so nothing reaches the real
// site. Markup follows what the bot's selectors expect (src/browser/selectors.ts), not a copy of Naukri.

export interface FakeQuestion {
  text: string;
  options?: string[];
}

export type FakeJobKind =
  // Apply sends the application at once and says so.
  | 'one-click'
  // Apply sends it but shows nothing; only a reload shows Applied.
  | 'quiet'
  // Apply does nothing at all.
  | 'no-response'
  | 'questions'
  // Apply opens a form in a dialog with its own Submit button.
  | 'form'
  // The same form with a required field nobody configured.
  | 'form-unknown'
  // Apply shows an error instead of applying.
  | 'error'
  | 'external'
  | 'applied'
  | 'no-button'
  | 'expired'
  | 'challenge'
  | 'unreachable';

export interface FakeJob {
  id: string;
  kind: FakeJobKind;
  questions?: FakeQuestion[];
}

export const jobUrl = (id: string) => `https://www.naukri.com/job-listings-test-role-acme-bengaluru-5-to-9-years-${id}`;

// A form with fields the bot knows (from the applicant facts and answers the tests configure) and one
// optional field it doesn't.
const FORM_FIELDS = `
  <label for="f-name">Full Name *</label><input id="f-name" name="name" required>
  <label for="f-email">Email *</label><input id="f-email" name="email" type="email" required>
  <label for="f-notice">Notice period *</label>
  <select id="f-notice" name="notice" required>
    <option value="">Select</option><option value="15">15 Days</option><option value="30">1 Month</option><option value="60">2 Months</option>
  </select>
  <fieldset><legend>Are you willing to relocate? *</legend>
    <input type="radio" id="r-yes" name="relocate" value="yes" required><label for="r-yes">Yes</label>
    <input type="radio" id="r-no" name="relocate" value="no"><label for="r-no">No</label>
  </fieldset>
  <label for="f-site">Portfolio URL</label><input id="f-site" name="portfolio">`;
const UNKNOWN_FIELD = '<label for="f-ctc">Current CTC (in lakhs) *</label><input id="f-ctc" name="ctc" required>';

const APPLY_SCRIPT = (id: string, kind: FakeJobKind, questions: FakeQuestion[]) => `
<script>
  const questions = ${JSON.stringify(questions)};
  const done = () => fetch('/fake/applied/${id}', { method: 'POST' });
  function success() {
    done().then(() => document.body.insertAdjacentHTML('beforeend', '<p>You have successfully applied to Test Role</p>'));
  }
  function ask(drawer, index) {
    const q = questions[index];
    const list = drawer.querySelector('ul');
    list.insertAdjacentHTML('beforeend', '<li><div class="botMsg"><span></span></div></li>');
    list.lastElementChild.querySelector('span').textContent = q.text;
    const options = drawer.querySelector('.options');
    options.innerHTML = '';
    for (const [i, option] of (q.options || []).entries()) {
      options.insertAdjacentHTML('beforeend',
        '<div class="ssrc__radio-btn-container"><input type="radio" name="q" id="o' + i + '"><label for="o' + i + '"></label></div>');
      options.lastElementChild.querySelector('label').textContent = option;
    }
    drawer.querySelector('[contenteditable]').style.display = q.options ? 'none' : 'block';
  }
  function openForm(unknownField) {
    const extra = unknownField ? ${JSON.stringify(UNKNOWN_FIELD)} : '';
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><form>' + ${JSON.stringify(FORM_FIELDS)} + extra + '<button type="submit">Submit</button></form></div>');
    const form = document.querySelector('[role=dialog] form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      fetch('/fake/form/${id}', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.parentElement.remove();
      success();
    });
  }
  document.querySelectorAll('#apply-button').forEach((button) => button.addEventListener('click', () => {
    fetch('/fake/click/${id}', { method: 'POST' });
    if (${JSON.stringify(kind)} === 'one-click') success();
    if (${JSON.stringify(kind)} === 'quiet') done();
    if (${JSON.stringify(kind)} === 'form') openForm(false);
    if (${JSON.stringify(kind)} === 'form-unknown') openForm(true);
    if (${JSON.stringify(kind)} === 'error') document.body.insertAdjacentHTML('beforeend', '<p>Something went wrong. Please try again.</p>');
    if (${JSON.stringify(kind)} !== 'questions') return;
    document.body.insertAdjacentHTML('beforeend', \`
      <div class="chatbot_DrawerContentWrapper">
        <ul><li><div class="botMsg"><span>Kindly answer all the recruiter's questions</span></div></li></ul>
        <div class="options"></div>
        <div contenteditable="true" class="textArea"></div>
        <div class="sendMsg">Save</div>
      </div>\`);
    const drawer = document.querySelector('.chatbot_DrawerContentWrapper');
    let index = 0;
    setTimeout(() => ask(drawer, 0), 100);
    drawer.querySelector('.sendMsg').addEventListener('click', () => {
      const picked = drawer.querySelector('input[type=radio]:checked');
      const answer = picked ? picked.nextElementSibling.textContent : drawer.querySelector('[contenteditable]').textContent;
      fetch('/fake/answer/${id}', { method: 'POST', body: answer });
      drawer.querySelector('[contenteditable]').textContent = '';
      index++;
      if (index < questions.length) return setTimeout(() => ask(drawer, index), 100);
      drawer.remove();
      success();
    });
  }));
</script>`;

function jobPage(job: FakeJob, applied: boolean): string {
  const header = '<title>Test Role - Acme</title><h1>Test Role</h1>';
  const api = `<script>fetch('/jobapi/v4/job/${job.id}')</script>`;
  switch (job.kind) {
    case 'applied':
      return `${header}${api}<div class="styles_jhc__apply-button-container__x"><span id="already-applied">Applied</span></div>`;
    case 'external':
      return `${header}${api}<div class="styles_jhc__apply-button-container__x"><button id="company-site-button">Apply on company site</button></div>`;
    case 'no-button':
      return `${header}${api}<p>Job description only</p>`;
    case 'expired':
      return `${header}<p>This job is no longer available</p>`;
    case 'challenge':
      return `${header}<iframe src="https://www.naukri.com/recaptcha/api2/bframe?k=x" width="300" height="300"></iframe>`;
    default:
      if (applied) return `${header}${api}<div class="styles_jhc__apply-button-container__x"><span id="already-applied">Applied</span></div>`;
      return `${header}${api}<div class="styles_jhc__apply-button-container__x"><button id="apply-button">Apply</button></div>
        <div class="sticky"><button id="apply-button" style="display:none">Apply</button></div>
        ${APPLY_SCRIPT(job.id, job.kind, job.questions ?? [])}`;
  }
}

export interface FakeNaukri {
  clicks: Map<string, number>;
  answers: Map<string, string[]>;
  forms: Map<string, Record<string, string>>;
  applied: Set<string>;
}

// `jobs` can be a function, read on every request, for a browser that outlives one test's job list.
export async function serveFakeNaukri(
  context: BrowserContext,
  jobs: FakeJob[] | (() => FakeJob[]),
  { loggedIn = true } = {},
): Promise<FakeNaukri> {
  const state: FakeNaukri = { clicks: new Map(), answers: new Map(), forms: new Map(), applied: new Set() };
  const find = (id: string) => (typeof jobs === 'function' ? jobs() : jobs).find((job) => job.id === id);
  await context.unrouteAll();
  await context.route('https://www.naukri.com/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const html = (body: string) => route.fulfill({ contentType: 'text/html', body });
    const [, action, id = ''] = pathname.match(/^\/fake\/(\w+)\/(\d+)$/) ?? [];
    if (action === 'click') state.clicks.set(id, (state.clicks.get(id) ?? 0) + 1);
    if (action === 'applied') state.applied.add(id);
    if (action === 'answer') state.answers.set(id, [...(state.answers.get(id) ?? []), request.postData() ?? '']);
    if (action === 'form') state.forms.set(id, JSON.parse(request.postData() ?? '{}'));
    if (action) return route.fulfill({ status: 204 });

    if (pathname === '/mnjuser/homepage') {
      return html(loggedIn ? '<a href="/mnjuser/profile">Profile</a>' : '<script>location.replace("/nlogin/login")</script>');
    }
    if (pathname.startsWith('/nlogin/')) return html('<input id="usernameField">');
    const apiId = pathname.match(/^\/jobapi\/v4\/job\/(\d+)$/)?.[1];
    if (apiId) {
      const external = find(apiId)?.kind === 'external';
      const body = { jobDetails: { jobId: apiId, ...(external && { applyRedirectUrl: 'https://careers.example.com/jobs/42' }) } };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    const job = find(pathname.match(/-(\d+)$/)?.[1] ?? '');
    if (!job) return route.fulfill({ status: 404, body: '' });
    if (job.kind === 'unreachable') return route.abort('connectionrefused');
    return html(jobPage(job, state.applied.has(job.id)));
  });
  return state;
}
