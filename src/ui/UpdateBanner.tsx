interface Props {
  needRefresh: boolean;
  onReload: () => void;
  onDismiss: () => void;
}

/** A bar shown when a new version of the app has been downloaded and is ready to use. */
export function UpdateBanner({ needRefresh, onReload, onDismiss }: Props) {
  if (!needRefresh) return null;
  return (
    <div className="update-banner" role="status">
      <span>A new version is ready.</span>
      <button type="button" className="primary" onClick={onReload}>Reload</button>
      <button type="button" onClick={onDismiss}>Later</button>
    </div>
  );
}
