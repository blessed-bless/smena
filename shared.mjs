export function isDate(value){
  if(typeof value!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=new Date(value+'T12:00:00Z');
  return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}

export function workday(state,date){
  const settings=state.settings;
  const override=state.dayOverrides&&Object.hasOwn(state.dayOverrides,date)?state.dayOverrides[date]:null;
  return {
    start:override?.start||settings.start,
    end:override?.end||settings.end,
    closed:override?override.closed:!settings.workdays.includes(new Date(date+'T12:00:00Z').getUTCDay()),
    overridden:!!override
  };
}
