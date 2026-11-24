import ReactMarkdown from 'react-markdown';

interface ContentAreaProps {
  content: string;
}

export function ContentArea({ content }: ContentAreaProps) {
  return (
    <div className="flex-1 h-screen overflow-y-auto bg-stone-900">
      <div className="max-w-4xl mx-auto px-8 py-12 lg:px-16 lg:py-24">
        <div className="prose prose-invert prose-stone max-w-none 
                        prose-headings:font-mono prose-headings:tracking-tight prose-headings:font-semibold
                        prose-h1:text-4xl prose-h1:mb-8 prose-h1:border-b prose-h1:border-stone-800 prose-h1:pb-4
                        prose-h2:text-2xl prose-h2:text-stone-200 prose-h2:mt-12
                        prose-h3:text-lg prose-h3:text-stone-300
                        prose-p:text-stone-300 prose-p:leading-relaxed
                        prose-li:text-stone-300 prose-li:marker:text-stone-600
                        prose-strong:text-stone-100 prose-strong:font-semibold
                        prose-code:text-stone-300 prose-code:bg-stone-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:before:content-none prose-code:after:content-none
                        prose-pre:bg-stone-950 prose-pre:border prose-pre:border-stone-800 prose-pre:shadow-xl
                        prose-blockquote:border-l-4 prose-blockquote:border-stone-600 prose-blockquote:bg-stone-800/30 prose-blockquote:py-1 prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-stone-400">
          <ReactMarkdown
            components={{
              table: ({node, ...props}) => <div className="overflow-x-auto"><table className="min-w-full text-left text-sm whitespace-nowrap" {...props} /></div>,
              th: ({node, ...props}) => <th className="px-4 py-3 border-b border-stone-800 font-mono font-medium text-stone-200" {...props} />,
              td: ({node, ...props}) => <td className="px-4 py-3 border-b border-stone-800/50 text-stone-300" {...props} />
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
