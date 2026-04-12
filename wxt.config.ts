import { defineConfig } from "wxt";

export default defineConfig({
	srcDir: "src",
	modules: ["@wxt-dev/module-react", "@wxt-dev/auto-icons"],
	vite: () => ({
		build: { sourcemap: true },
	}),
	manifest: {
		name: "Playback Speed Control",
		description: "A playback speed controller for video and audio players",
		permissions: ["storage"],
		browser_specific_settings: {
			gecko: {
				id: "playback-speed-controller@dougg0k",
				// @ts-expect-error - missing in current WXT typings
				data_collection_permissions: {
					required: ["none"],
				},
			},
		},
	},
});
