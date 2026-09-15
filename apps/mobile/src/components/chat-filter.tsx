import { Host } from "@expo/ui";
import { Picker, Text, VStack } from "@expo/ui/swift-ui";
import {
  font,
  frame,
  glassEffect,
  padding,
  pickerStyle,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import {
  CHAT_TAB_LABEL,
  CHAT_TABS,
  type ChatTab,
} from "@/lib/chatFilters";
import { useHostColorScheme } from "@/components/ui";

export function ChatFilter({
  value,
  onChange,
  offline = false,
}: {
  value: ChatTab;
  onChange: (tab: ChatTab) => void;
  offline?: boolean;
}) {
  const colorScheme = useHostColorScheme();
  return (
    <Host
      matchContents={{ vertical: true }}
      colorScheme={colorScheme}
      style={{ alignSelf: "stretch", backgroundColor: "transparent" }}
    >
      <VStack
        spacing={8}
        modifiers={[
          padding({ horizontal: 16, vertical: 8 }),
          frame({ maxWidth: Infinity }),
        ]}
      >
        <Picker
          selection={value}
          onSelectionChange={(tab) => {
            if (typeof tab === "string" && tab in CHAT_TAB_LABEL)
              onChange(tab as ChatTab);
          }}
          modifiers={[
            pickerStyle("segmented"),
            padding({ horizontal: 5, vertical: 5 }),
            frame({ maxWidth: Infinity }),
            glassEffect({
              glass: { variant: "regular" },
              shape: "capsule",
            }),
          ]}
        >
          {CHAT_TABS.map((tab) => (
            <Text key={tab} modifiers={[tag(tab)]}>
              {CHAT_TAB_LABEL[tab]}
            </Text>
          ))}
        </Picker>
        {offline ? (
          <Text
            modifiers={[
              font({ textStyle: "caption", weight: "medium" }),
              padding({ horizontal: 10, vertical: 5 }),
              glassEffect({
                glass: { variant: "regular" },
                shape: "capsule",
              }),
            ]}
          >
            Offline
          </Text>
        ) : null}
      </VStack>
    </Host>
  );
}


