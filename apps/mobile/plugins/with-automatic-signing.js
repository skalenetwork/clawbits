const { IOSConfig, withXcodeProject } = require("expo/config-plugins");

/** app.json `appleTeamId` writes DEVELOPMENT_TEAM only. Device builds still need Automatic style. */
function withAutomaticSigning(config) {
  return withXcodeProject(config, (config) => {
    const team = config.ios?.appleTeamId;
    if (!team) return config;
    const project = config.modResults;
    const quoted = `"${team}"`;
    for (const [nativeTargetId, nativeTarget] of IOSConfig.Target.findSignableTargets(
      project,
    )) {
      for (const [, item] of IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
        project,
        nativeTarget.buildConfigurationList,
      )) {
        if (!item.buildSettings?.PRODUCT_NAME) continue;
        item.buildSettings.DEVELOPMENT_TEAM = quoted;
        item.buildSettings.CODE_SIGN_IDENTITY = '"Apple Development"';
        item.buildSettings.CODE_SIGN_STYLE = "Automatic";
      }
      for (const [, item] of Object.entries(
        IOSConfig.XcodeUtils.getProjectSection(project),
      )) {
        if (!item || typeof item !== "object" || !item.attributes) continue;
        item.attributes.TargetAttributes ??= {};
        item.attributes.TargetAttributes[nativeTargetId] ??= {};
        item.attributes.TargetAttributes[nativeTargetId].DevelopmentTeam = quoted;
        item.attributes.TargetAttributes[nativeTargetId].ProvisioningStyle =
          "Automatic";
      }
    }
    return config;
  });
}

module.exports = withAutomaticSigning;
