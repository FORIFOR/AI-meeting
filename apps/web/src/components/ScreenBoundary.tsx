import { Component, Suspense, type ReactNode } from "react";

interface ScreenBoundaryProps {
  children: ReactNode;
  onHome: () => void;
}

/** Navigation stays responsive even while a screen chunk is slow or unavailable. */
export class ScreenBoundary extends Component<ScreenBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return (
        <main className="screen-feedback">
          <p role="alert">画面を読み込めませんでした。接続を確認して、もう一度お試しください。</p>
          <div className="actions">
            <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>再読み込み</button>
            <button type="button" className="btn btn--ghost" onClick={this.props.onHome}>ホームへ戻る</button>
          </div>
        </main>
      );
    }
    return (
      <Suspense fallback={
        <main className="screen-feedback" aria-busy="true">
          <p role="status">画面を準備しています…</p>
          <button type="button" className="btn btn--ghost" onClick={this.props.onHome}>ホームへ戻る</button>
        </main>
      }>
        {this.props.children}
      </Suspense>
    );
  }
}
