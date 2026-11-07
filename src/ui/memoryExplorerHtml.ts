import { escapeHtml } from '../i18n';
import { featureText as f } from './featureLocale';
export function explorerBody(): string {
  const label = (value: string) => escapeHtml(f(value));
  const button = (id: string, value: string) => '<button class="secondary" id="'+id+'">'+label(value)+'</button>';
  return '<div class="studio-card memory-explorer" id="memory-explorer">'+
    '<div class="card-heading"><div><h2>'+label('Allocation explorer')+'</h2></div><div class="actions">'+button('tree-back','Back')+button('tree-reset','All regions')+button('tree-details','Symbol details')+button('tree-expand','Expand view')+'</div></div>'+
    '<div id="tree-legend" class="tree-legend"></div><div class="explorer-toolbar"><nav id="tree-breadcrumb" aria-label="'+label('Memory navigation')+'"></nav><div class="zoom-controls">'+button('tree-zoom-out','Zoom out')+'<output id="tree-zoom-level" aria-label="'+label('Zoom level')+'">100%</output>'+button('tree-zoom-in','Zoom in')+'</div></div>'+
    '<div id="treemap" class="chart" role="img" aria-label="'+label('Allocation explorer')+'"></div>'+
    '<section id="hex-view" hidden><div class="hex-heading"><span id="hex-source" class="source-badge"></span><h3 id="hex-title"></h3></div><div id="hex-addresses" class="hex-addresses"></div><p id="hex-status" class="hint" role="status"></p><div class="hex-scroll"><div id="hex-table"></div></div><p id="hex-selection" aria-live="polite"></p>'+
    '<div class="hex-controls"><div class="pager">'+button('hex-previous','Previous')+'<span id="hex-page-label"></span>'+button('hex-next','Next')+'</div><form id="hex-jump-form"><label for="hex-jump">'+label('Go to address')+'</label><input id="hex-jump" placeholder="0x08000000" spellcheck="false" autocomplete="off"><button type="submit" class="secondary">'+label('Go')+'</button></form></div></section>'+
    '<div class="tree-selection"><strong id="tree-selection-name"></strong><span id="tree-selection-detail"></span></div><p id="tree-help" class="hint"></p><details id="tree-accessible"><summary>'+label('Browse as list')+'<span id="tree-count"></span></summary><div id="tree-list"></div></details></div>';
}
