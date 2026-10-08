const fs = require("fs");
const path = require("path");
const { IOSConfig, withXcodeProject } = require("expo/config-plugins");

const FILE = "ClawbitsProminentTab.m";

/** iOS 27 only splits a tab into its own circle when it is the prominent tab. */
function withProminentTab(config) {
  return withXcodeProject(config, (config) => {
    const projectRoot = config.modRequest.platformProjectRoot;
    const source = path.join(config.modRequest.projectRoot, "native", FILE);
    const destination = path.join(projectRoot, "Clawbits", FILE);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    const project = config.modResults;
    const filepath = `Clawbits/${FILE}`;
    if (!project.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath,
        groupName: "Clawbits",
        project,
      });
    }
    return config;
  });
}

module.exports = withProminentTab;
