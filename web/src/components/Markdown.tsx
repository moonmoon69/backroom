import { memo, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Participant replies as GitHub-flavoured markdown. Raw HTML is never rendered (no rehype-raw), and
 * react-markdown's default URL transform drops javascript: and similar links.
 */
const components: Components = {
  a: ({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // Wide GitHub tables scroll inside the bubble instead of stretching it.
  table: ({ node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) => (
    <div className="md-table">
      <table {...props} />
    </div>
  ),
};

const plugins = [remarkGfm];

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
