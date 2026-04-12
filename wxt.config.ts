import { defineConfig } from "wxt";

export default defineConfig({
	vite: () => ({
		build: { sourcemap: true },
	}),
	srcDir: "src",
	modules: ["@wxt-dev/module-react", "@wxt-dev/auto-icons"],
	manifest: {
		name: "Playback Speed Control",
		description: "A playback speed controller for Video / Audio players",
		permissions: ["storage"],
		host_permissions: [],
		browser_specific_settings: {
			gecko: {
				id: "playback-speed-controller@dougg0k",
				// @ts-expect-error - missing in current WXT typings
				data_collection_permissions: {
					required: ["none"],
				},
			},
		},
		web_accessible_resources: [
			{
				resources: ["/injected.js"],
				matches: [],
			},
		],
	},
});
