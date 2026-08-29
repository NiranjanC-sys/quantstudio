export function Margin({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <aside className="rq-margin">
      {label ? <span className="rq-margin-label">{label}</span> : null}
      {children}
    </aside>
  );
}
