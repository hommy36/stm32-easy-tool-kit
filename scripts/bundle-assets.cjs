const fs=require('node:fs');
fs.mkdirSync('resources/vendor',{recursive:true});
fs.copyFileSync('node_modules/echarts/dist/echarts.min.js','resources/vendor/echarts.min.js');
fs.copyFileSync('node_modules/echarts/LICENSE','resources/vendor/ECHARTS-LICENSE.txt');

fs.copyFileSync('node_modules/echarts/NOTICE','resources/vendor/ECHARTS-NOTICE.txt');
fs.copyFileSync('node_modules/echarts/licenses/LICENSE-d3','resources/vendor/D3-LICENSE.txt');
