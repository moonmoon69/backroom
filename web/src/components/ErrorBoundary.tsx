import { Component, type ReactNode } from "react";

interface Props {
  /** Clears whatever was being shown (the selection), so the app can render something else. */
  onReset: () => void;
  /** Shown above the error (the header, so the sidebar button still works on a phone). */
  header: ReactNode;
  children: ReactNode;
}

/**
 * Keeps a render error in the main area from blanking the whole app: the sidebar stays usable and the error is shown
 * with a way back. Remount it (key) when the selection changes so the next view gets a fresh start.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error(error);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <>
      {this.props.header}
      <div className="empty-state" role="alert">
        <p className="serif">This view failed to render.</p>
        <p className="mono muted">{this.state.error.message}</p>
        <p className="muted">If the room service was just updated, restart it and reload.</p>
        <div className="row">
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset();
            }}
          >
            Close this view
          </button>
          <button type="button" className="ghost" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
      </>
    );
  }
}
