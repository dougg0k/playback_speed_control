import { defineContentScript } from "wxt/utils/define-content-script";

export default defineContentScript({
	matches: ["*://*.google.com/*"],
	main() {
		console.log("Hello content.");
	},
});
