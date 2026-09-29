import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import * as WebBrowser from "expo-web-browser";
import { ActivityIndicator, Alert, DynamicColorIOS, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { color, useHostColorScheme } from "@/components/ui";
import { api } from "@/lib/api";
import { type McpBrand, mcpBrand, signInDomain } from "@/lib/mcpBrands";
import { useSession } from "@/lib/session";

const shade = {
  line: DynamicColorIOS({ light: "rgba(0,0,0,0.6)", dark: "rgba(255,255,255,0.64)" }),
  quiet: DynamicColorIOS({ light: "rgba(0,0,0,0.07)", dark: "rgba(255,255,255,0.1)" }),
  okFill: DynamicColorIOS({ light: "rgba(36,138,61,0.14)", dark: "rgba(48,209,88,0.16)" }),
  ok: DynamicColorIOS({ light: "#155D27", dark: "#63E28A" }),
};

/** Sign in through the provider in an auth session that returns to the app, then hand the code to the agent.
 *  The token is read again afterwards: the session may have rotated while the provider page was open. */
async function connectMcp(token: () => string | undefined, linkId: string): Promise<void> {
  try {
    const { url } = await api.claimMcpConnect(token() ?? "", linkId);
    const result = await WebBrowser.openAuthSessionAsync(url, "clawbits://mcp-callback");
    if (result.type !== "success") return;
    const grant = new URL(result.url).searchParams;
    const code = grant.get("code");
    if (!code) throw new Error("The provider declined the sign-in.");
    await api.completeMcpSignIn(token() ?? "", grant.get("state") ?? "", code);
  } catch (err) {
    Alert.alert("Sign-in failed", err instanceof Error ? err.message : undefined);
  }
}

/** The service's mark on its tile; a neutral tile, with an optional symbol, for anything else. */
function Tile({ brand, symbol }: { brand?: McpBrand; symbol?: SymbolViewProps["name"] }) {
  const dark = useHostColorScheme() === "dark";
  const colors = brand && brand.tile !== "ink" ? brand.tile : undefined;
  return (
    <View style={[card.tile, { backgroundColor: colors?.fill ?? (brand ? color.text : shade.quiet) }]}>
      {brand ? (
        <Svg width={22} height={22} viewBox={brand.viewBox}>
          <Path d={brand.d} fill={colors?.mark ?? (dark ? "#000000" : "#FFFFFF")} />
        </Svg>
      ) : (
        symbol && <SymbolView name={symbol} size={20} tintColor={color.muted} />
      )}
    </View>
  );
}

/** An agent's request to sign in to an MCP server; its text comes from the server, never the message. The logo and
 *  proper name appear only when the sign-in host belongs to a known service. */
export function McpConnectCard({ linkId }: { linkId: string }) {
  const { session, token } = useSession();
  const queryClient = useQueryClient();
  const key = ["mcp-connect-link", linkId];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.mcpConnectLink(session?.token ?? "", linkId),
    enabled: Boolean(session),
    refetchInterval: (query) => (query.state.data?.status === "connecting" ? 2000 : false),
  });
  const connect = useMutation({
    mutationFn: () => connectMcp(token, linkId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const status = data === null ? "inactive" : (data?.status ?? "loading");
  const brand = data ? mcpBrand(data.host) : undefined;
  const name = brand?.name ?? data?.server;
  const agent = data?.agent_name;
  const domain = data && <Text style={card.domain}>{signInDomain(data.host)}</Text>;
  const title = {
    open: `Connect ${name}`,
    connecting: `Connecting ${name}`,
    connected: `Signed in to ${name}`,
    inactive: "This link is no longer active",
    loading: "Connect MCP server",
  }[status];
  const line = {
    open: <>{agent} asks you to sign in at {domain}.</>,
    connecting: `${agent} is finishing the sign-in.`,
    connected: <>{agent} is signed in at {domain}.</>,
    inactive: "Ask the agent for a new one.",
    loading: null,
  }[status];

  return (
    <View style={card.row}>
      <Tile brand={brand} symbol={data === null ? "clock.badge.xmark" : data && "powerplug"} />
      <View style={card.text}>
        <Text numberOfLines={1} style={card.title}>{title}</Text>
        {line && <Text style={card.line}>{line}</Text>}
      </View>
      {status === "open" && session && (
        <Pressable
          accessibilityRole="button"
          hitSlop={6}
          disabled={connect.isPending}
          onPress={() => {
            connect.mutate();
          }}
        >
          {({ pressed }) => (
            <View style={[card.pill, { backgroundColor: color.text }, pressed && { opacity: 0.6 }]}>
              <Text style={[card.pillText, { color: color.background }]}>Connect</Text>
            </View>
          )}
        </Pressable>
      )}
      {status === "connecting" && (
        <View style={[card.pill, { backgroundColor: shade.quiet }]}>
          <ActivityIndicator size="small" color={color.text} />
          <Text style={[card.pillText, { color: color.text }]}>Connecting</Text>
        </View>
      )}
      {status === "connected" && (
        <View style={[card.pill, { backgroundColor: shade.okFill }]}>
          <SymbolView name="checkmark" size={13} weight="bold" tintColor={shade.ok} />
          <Text style={[card.pillText, { color: shade.ok }]}>Connected</Text>
        </View>
      )}
    </View>
  );
}

const card = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  tile: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  text: { flex: 1 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: "600", color: color.text },
  line: { fontSize: 13, lineHeight: 18, color: shade.line },
  domain: { fontWeight: "500", color: color.text },
  pill: { height: 32, borderRadius: 16, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 5 },
  pillText: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
});
