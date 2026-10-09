import { View } from "react-native";
import { normalizeBoards, type WidgetAction, type WidgetScene } from "@/lib/widgets";
import { BoardView } from "./board-view";
import { CardTable } from "./card-table";

/** Draws any widget scene: one board, several (stacked, on a phone), or a card table. */
export function SceneView({
  scene,
  seat,
  busy,
  onAct,
}: {
  scene: WidgetScene;
  /** The viewer's seat; null for a spectator, who never acts. */
  seat: string | null;
  /** An action is in flight: the board waits for its answer. */
  busy: boolean;
  onAct: (action: WidgetAction) => void;
}) {
  if (scene.table) return <CardTable rows={scene.table.rows} />;
  const boards = normalizeBoards(scene);
  const input = seat ? scene.input?.[seat] : undefined;
  const inputBoard = input?.board ?? boards[0]?.id;
  const flip = seat != null && scene.flip_for === seat;
  return (
    <View style={{ gap: 14 }}>
      {boards.map((board) => (
        <BoardView
          key={board.id}
          board={board}
          scene={scene}
          input={input && inputBoard === board.id ? input : undefined}
          flip={flip}
          busy={busy}
          onAct={onAct}
        />
      ))}
    </View>
  );
}
