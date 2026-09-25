// Every Naukri URL and selector lives here so a site change is a one-file fix.

export const NAUKRI_URLS = {
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
