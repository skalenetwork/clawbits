import { Host } from "@expo/ui";
import {
  Button,
  Form,
  Label,
  LabeledContent,
  Link,
  Section,
  Text,
  Toggle,
} from "@expo/ui/swift-ui";
import {
  disabled as disabledModifier,
  foregroundStyle,
  lineLimit,
} from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";
import { Alert } from "react-native";
import { agentName, gameSwitchAgents } from "@/lib/agents";
import { api, ApiError } from "@/lib/api";
import { useAgentGamesSwitch, useOrganizations, useOrgAgents } from "@/lib/data";
import { useSession } from "@/lib/session";
import { useHostColorScheme } from "@/components/ui";

const PRIVACY_URL = "https://clawbits.ai/privacy/";
const TERMS_URL = "https://clawbits.ai/terms/";

export default function Settings() {
  const { session, signOut } = useSession();
  const [deleting, setDeleting] = useState(false);
  const colorScheme = useHostColorScheme();
  const name = session?.user.display_name?.trim() || "—";
  const email = session?.user.email ?? "";
  // "Can play games" for the agents this person runs, or all of the org's for its owner.
  const { selected: organization } = useOrganizations();
  const agents = useOrgAgents(organization?.org_id);
  const games = useAgentGamesSwitch(organization?.org_id);
  const switchable = gameSwitchAgents(agents.data ?? [], organization);

  const confirmSignOut = () => {
    Alert.alert("Sign out?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          void signOut();
        },
      },
    ]);
  };

  const remove = async () => {
    if (!session || deleting) return;
    setDeleting(true);
    try {
      await api.deleteAccount(session.token);
      await signOut();
    } catch (error) {
      setDeleting(false);
      Alert.alert(
        "Could not delete account",
        error instanceof ApiError ? error.message : "Please try again.",
      );
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      "Delete account?",
      "This permanently deletes your account and its data. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: () => {
            void remove();
          },
        },
      ],
    );
  };

  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement colorScheme={colorScheme}>
      <Form>
        <Section title="Account">
          <LabeledContent label="Name">
            <Text modifiers={[lineLimit(1)]}>{name}</Text>
          </LabeledContent>
          <LabeledContent label="Email">
            <Text modifiers={[lineLimit(1)]}>{email}</Text>
          </LabeledContent>
        </Section>
        {switchable.length > 0 ? (
          <Section
            title="Agents"
            footer={<Text>People can start chat games like chess with them. Turning one off ends its games.</Text>}
          >
            {switchable.map((agent) => (
              <Toggle
                key={agent.agent_id}
                isOn={Boolean(agent.widgets_enabled)}
                onIsOnChange={(enabled) => {
                  games.mutate({ agent: agent.agent_id, enabled });
                }}
                modifiers={[disabledModifier(games.isPending && games.variables?.agent === agent.agent_id)]}
              >
                <Text modifiers={[lineLimit(1)]}>{agentName(agent)}</Text>
                <Text>Can play games</Text>
              </Toggle>
            ))}
          </Section>
        ) : null}
        <Section>
          <Button
            label="Sign out"
            systemImage="rectangle.portrait.and.arrow.right"
            onPress={confirmSignOut}
          />
        </Section>
        <Section
          footer={
            <Text>
              Hand off agents and organizations you own before deleting.
            </Text>
          }
        >
          <Button
            role="destructive"
            onPress={confirmDelete}
            modifiers={[foregroundStyle("red"), disabledModifier(deleting)]}
          >
            <Label
              title={deleting ? "Deleting…" : "Delete account"}
              systemImage="trash"
            />
          </Button>
        </Section>
        <Section title="Legal">
          <Link label="Privacy policy" destination={PRIVACY_URL} />
          <Link label="Terms of service" destination={TERMS_URL} />
        </Section>
      </Form>
    </Host>
  );
}
