import { Host } from "@expo/ui";
import { Button, Menu } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  controlSize,
  frame,
  labelStyle,
} from "@expo/ui/swift-ui/modifiers";
import { Alert } from "react-native";
import { useOrganizations } from "@/lib/data";
import { useSession } from "@/lib/session";

export function OrgMenu() {
  const { organizations, selected } = useOrganizations();
  const { selectOrg, signOut } = useSession();
  const name = selected?.display_name || selected?.name || "Account";
  const failed = (error: unknown) =>
    Alert.alert(
      "Could not update account",
      error instanceof Error ? error.message : "Please try again.",
    );
  return (
    <Host matchContents>
      <Menu
        label={name}
        systemImage="building.2"
        modifiers={[
          buttonStyle("plain"),
          buttonBorderShape("circle"),
          controlSize("large"),
          labelStyle("iconOnly"),
          frame({ width: 32, height: 32 }),
          accessibilityLabel(name),
        ]}
      >
        {organizations.map((org) => (
          <Button
            key={org.org_id}
            label={org.display_name || org.name}
            systemImage={
              org.org_id === selected?.org_id ? "checkmark" : "building.2"
            }
            onPress={() => {
              void selectOrg(org.org_id).catch(failed);
            }}
          />
        ))}
        <Button
          label="Sign Out"
          systemImage="rectangle.portrait.and.arrow.right"
          role="destructive"
          onPress={() =>
            Alert.alert("Sign out?", undefined, [
              { text: "Cancel", style: "cancel" },
              {
                text: "Sign Out",
                style: "destructive",
                onPress: () => {
                  void signOut().catch(failed);
                },
              },
            ])
          }
        />
      </Menu>
    </Host>
  );
}
