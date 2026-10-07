import { Component, type ReactNode } from "react";

interface Props {
  /** Clears whatever was being shown (the selection), so the app can render something else. */
  onReset: () => void | Promise<void>;
  /** Shown above the error (the header, so its way back still works). */
  header: ReactNode;
  children: ReactNode;
  /** Smaller surfaces keep their own close/retry action instead of closing the selected conversation. */
  recovery?: { message: string; action: string };
}

/**
 * Keeps a render error in the main area from blanking the whole app: the rest stays usable and the error is shown
 * with a way back. Remount it (key) when the selection changes so the next view gets a fresh start.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error): void {
    console.error(error);
  }

  private reset = async (): Promise<void> => {
    try {
      // A picker can reread its catalog before remounting, instead of retrying the same broken cached data.
      await this.props.onReset();
      this.setState({ error: null });
    } catch (error) {
      this.setState(ErrorBoundary.getDerivedStateFromError(error));
    }
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <>
      {this.props.header}
      <div className="empty-state" role="alert">
        <p className="serif">{this.props.recovery?.message ?? "This view failed to render."}</p>
        <p className="mono muted">{this.state.error.message}</p>
        <p className="muted">{this.props.recovery ? "Try again, or reload if the problem continues." : "If Backroom was just updated, restart the service and reload."}</p>
        <div className="row">
          <button
            type="button"
            onClick={() => void this.reset()}
          >
            {this.props.recovery?.action ?? "Close this view"}
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
