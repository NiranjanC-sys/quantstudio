export function Callout({
  children,
  tone = 'note',
  title,
}: {
  children: React.ReactNode;
  tone?: 'note' | 'warning' | 'gotcha';
  title?: string;
}) {
  return (
    <div className={`rq-callout rq-callout-${tone}`}>
      {title ? <p className="rq-callout-title">{title}</p> : null}
      {children}
    </div>
  );
}
