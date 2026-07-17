type Props = {
  className?: string;
};

export function SiteFooter({ className = "" }: Props) {
  return (
    <footer className={`site-footer${className ? ` ${className}` : ""}`}>
      &copy; 2026 Md. Rakib <span aria-hidden="true">&bull;</span> made with love and passion.
    </footer>
  );
}
