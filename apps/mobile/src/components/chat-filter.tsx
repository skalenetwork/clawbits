import { Host } from "@expo/ui";
import { Picker, Text } from "@expo/ui/swift-ui";
import { padding, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import {
  CHAT_TAB_LABEL,
  CHAT_TABS,
  type ChatTab,
} from "@/lib/chatFilters";

export function ChatFilter({
  value,
  onChange,
}: {
  value: ChatTab;
  onChange: (tab: ChatTab) => void;
}) {
  return (
    <Host matchContents={{ vertical: true }} style={{ alignSelf: "stretch" }}>
      <Picker
        selection={value}
        onSelectionChange={(tab) => {
          if (typeof tab === "string" && tab in CHAT_TAB_LABEL)
            onChange(tab as ChatTab);
        }}
        modifiers={[
          pickerStyle("segmented"),
          padding({ horizontal: 16, vertical: 8 }),
        ]}
      >
        {CHAT_TABS.map((tab) => (
          <Text key={tab} modifiers={[tag(tab)]}>
            {CHAT_TAB_LABEL[tab]}
          </Text>
        ))}
      </Picker>
    </Host>
  );
}
