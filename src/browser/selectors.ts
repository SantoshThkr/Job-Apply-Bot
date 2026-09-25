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
