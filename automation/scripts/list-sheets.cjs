const XLSX = require('xlsx');
const wb = XLSX.readFile('C:/Users/inwon/Downloads/CCOREA_ItemData.xlsx');
wb.SheetNames.forEach((name, i) => {
  const ws = wb.Sheets[name];
  const ref = ws['!ref'] || '(empty)';
  let rows = 0, cols = 0;
  if (ref !== '(empty)') {
    const range = XLSX.utils.decode_range(ref);
    rows = range.e.r + 1;
    cols = range.e.c + 1;
  }
  console.log(i + ': [' + name + '] ' + rows + ' rows x ' + cols + ' cols');
});
