// Fetch and AbortController polyfills for Node 14 compatibility
/* eslint-disable @typescript-eslint/no-require-imports */

let fetchPolyfill: typeof fetch;
let AbortControllerPolyfill: typeof AbortController;

if (typeof fetch === 'undefined') {
  try {
    // Use node-fetch in Node.js environments that don't have global fetch
    fetchPolyfill = require('node-fetch') as typeof fetch;
  } catch {
    throw new Error(
      'node-fetch is required for Node 14 compatibility. Please install it: npm install node-fetch@2'
    );
  }
} else {
  fetchPolyfill = fetch;
}

if (typeof AbortController === 'undefined') {
  try {
    // Use abort-controller in environments that don't have AbortController
    AbortControllerPolyfill = require('abort-controller') as typeof AbortController;
  } catch {
    throw new Error(
      'abort-controller is required for Node 14 compatibility. Please install it: npm install abort-controller'
    );
  }
} else {
  AbortControllerPolyfill = AbortController;
}

export { fetchPolyfill, AbortControllerPolyfill };


