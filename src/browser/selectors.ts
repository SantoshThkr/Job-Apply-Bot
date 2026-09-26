// Every Naukri URL and selector lives here so a site change is a one-file fix.

export const NAUKRI_URLS = {
  base: 'https://www.naukri.com',
  login: 'https://www.naukri.com/nlogin/login',
  // Anonymous visitors are redirected client-side (after `load`) to /nlogin/login?URL=<this page>.
  loggedInHome: 'https://www.naukri.com/mnjuser/homepage',
};

// Match on pathname only: the login URL carries the logged-in URL in its ?URL= query string.
export const NAUKRI_PATHS = {
  login: '/nlogin/',
  loggedInArea: '/mnjuser/',
};

export const SESSION_SELECTORS = {
  // Profile link on the logged-in homepage; confirmed absent on the logged-out home and login pages.
  loggedInMarker: 'a[href*="/mnjuser/profile"]',
  loginForm: '#usernameField',
};

export const CHALLENGE_SELECTORS = {
  // Invisible reCAPTCHA badges sit on ordinary pages, so only the checkbox and the image popup count.
  frames: [
    'iframe[src*="/recaptcha/"][src*="bframe"]',
    'iframe[src*="/recaptcha/"][src*="anchor"]:not([src*="size=invisible"])',
    'iframe[src*="hcaptcha.com"]',
    'iframe[src*="challenges.cloudflare.com"]',
  ].join(', '),
  otpInput: 'input[autocomplete="one-time-code"]',
  text: /verify (that )?you are (a )?human|unusual traffic|are you a robot/i,
  // Akamai's edge block page. Headless Chrome always gets this on Naukri.
  blockedTitle: /^access denied$/i,
};

// The results page loads its jobs from this endpoint. Reading the response the page already
// received is sturdier than scraping styled markup. Any API version matches; `search?` excludes
// the similar-jobs call (/jobapi/v2/search/simjobs/...) made by job pages.
export const SEARCH_API = /\/jobapi\/v\d+\/search\?/;

// Naukri treats Remote as a work-mode filter, not a location.
export const REMOTE_FILTER: [string, string] = ['wfhType', '2'];

// "Freshness" in Naukri's filters: jobs posted within this many days.
export const FRESHNESS_FILTER = 'jobAge';

// Fallback when the search response can't be read.
export const SEARCH_SELECTORS = {
  card: '[data-job-id]',
  title: 'a.title',
  company: '.comp-name',
  experience: '.expwdth',
  salary: '.sal-wrap span[title]',
  location: '.locWdth',
  posted: '.job-post-day',
  tags: '.tag-li',
  // Class names carry build hashes (styles_pagination__oIvXh), so match the stable part and the label.
  nextPage: '[class*="pagination" i] a:has(> span:text-is("Next"))',
};

export const DETAIL_SELECTORS = {
  // schema.org JobPosting, injected client-side after DOMContentLoaded.
  jsonLd: 'script[type="application/ld+json"]',
  // Fallback: the <section> around this heading holds the description.
  descriptionHeading: 'Job description',
};

// The job page's own API response. For company-site jobs, jobDetails.applyRedirectUrl holds the
// external URL (confirmed 2026-09-25), so the bot can record it without clicking through.
export const JOB_API = /\/jobapi\/v\d+\/job\/\d+(?:\?|$)/;

export const APPLY_SELECTORS = {
  // Confirmed on live job pages (2026-09-25). Each appears twice: header and sticky bar.
  applyButton: '#apply-button',
  companySiteButton: '#company-site-button',
  // Matched on one live applied job so far: Naukri shows "Applied" where the Apply button was.
  appliedMarker: '#already-applied, [class*="apply-button-container"] :is(button, span):text-is("Applied")',
  unavailableText: /no longer accepting applications|job (has )?expired|this job is no longer available/i,
  // Not yet seen after a real application: Naukri's confirmation text and post-apply page.
  successText: /you have successfully applied|successfully applied to|applied successfully/i,
  successPath: '/myapply/saveApply',
  // Not yet seen on a real questionnaire: the chat drawer where recruiters' questions appear one at a time.
  questionnaire: '[class*="chatbot_Drawer"]',
  botMessage: '[class*="botMsg"]',
  textInput: '[contenteditable="true"], textarea, input[type="text"], input[type="number"]',
  radioOption: '[class*="ssrc__radio-btn-container"], [role="radio"]',
  checkboxOption: '[class*="mcc__checkbox"], [role="checkbox"]',
  chipOption: '[class*="chatbot_Chip"]',
  fileInput: 'input[type="file"]',
  unsupportedInput: 'select, input[type="date"]',
  saveButton: '[class*="sendMsg"]',
  // Not yet seen on Naukri: an application form in a dialog, with a submit button of its own.
  applyForm: '[role="dialog"]:has(input, select, textarea)',
  formField: 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea',
  formSubmit: 'button[type="submit"], button:text-matches("^(submit|apply|send)( application)?$", "i")',
  // Not yet seen after a real application: wording for an application that did not go through.
  errorText: /something went wrong|could not be (applied|submitted)|unable to (apply|process your application)|failed to apply/i,
};
