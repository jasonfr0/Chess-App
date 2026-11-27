import { Component, type ReactNode } from 'react';

interface State { error: Error | null }

/**
 * If anything throws while drawing the app, show what went wrong and a way out, instead of a screen
 * that silently stops responding. The message helps track down the problem.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app-error" role="alert">
        <h2>Something went wrong</h2>
        <p>The app hit an error and stopped. Your saved games are safe.</p>
        <pre>{error.message}</pre>
        <button type="button" className="primary" onClick={() => location.reload()}>Reload the app</button>
      </div>
    );
  }
}
