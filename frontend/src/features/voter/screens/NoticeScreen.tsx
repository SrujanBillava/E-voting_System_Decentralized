import { usePageTitle } from "../../../components/useRouteFocus";
import { KioskFrame } from "../KioskFrame";

/** Terminal notices: unavailable / voting closed / session timed out. */
export default function NoticeScreen({ title, text, action }: { title: string; text: string; action?: { label: string; onClick: () => void } }) {
  usePageTitle(title);
  return (
    <KioskFrame
      title={title}
      intro={text}
      primary={
        action ? (
          <button type="button" className="btn btn-primary btn-lg" onClick={action.onClick}>
            {action.label}
          </button>
        ) : undefined
      }
    />
  );
}
