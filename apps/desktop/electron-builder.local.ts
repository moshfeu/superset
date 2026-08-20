/**
 * Electron Builder Configuration - Local Build
 *
 * Extends the base config with local-dev-specific overrides so a machine-local
 * build never collides with the installed production app on bundle identity.
 * A shared appId with the production build makes macOS TCC (Documents folder,
 * etc.) treat both apps as the same client and re-prompt whenever either one's
 * code signature doesn't match what was last granted. Giving the local build
 * its own appId keeps its permission grants independent and stable across
 * local rebuilds.
 *
 * Can be installed side-by-side with the stable release.
 *
 * @see https://www.electron.build/configuration/configuration
 */

import { join } from "node:path";
import type { Configuration } from "electron-builder";
import baseConfig from "./electron-builder";
import pkg from "./package.json";

const productName = "Superset Local";
const localMacIconPath = join(pkg.resources, "build/icons/icon.icns");

const config: Configuration = {
	...baseConfig,
	appId: "com.superset.desktop.local",
	productName,

	// Local builds are never published.
	publish: null,

	mac: {
		...baseConfig.mac,
		icon: localMacIconPath,
		artifactName: `Superset-Local-\${version}-\${arch}.\${ext}`,
		extendInfo: {
			...baseConfig.mac?.extendInfo,
			CFBundleName: productName,
			CFBundleDisplayName: productName,
		},
	},
};

export default config;
