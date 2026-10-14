// Vercel serverless function: ดึงข้อมูลตลาดฝั่งเซิร์ฟเวอร์ (ไม่ต้องใช้ API key)
const UA={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',Accept:'application/json'};
const Y='https://query1.finance.yahoo.com';
const j=async(u,h=UA)=>{const r=await fetch(u,{headers:h,signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error(r.status+' '+new URL(u).hostname);return r.json()};
const chart=(s,range,int)=>j(`${Y}/v8/finance/chart/${encodeURIComponent(s)}?range=${range}&interval=${int}`).then(d=>d.chart.result[0]);
const news=async s=>((await j(`${Y}/v1/finance/search?q=${encodeURIComponent(s)}&newsCount=8&quotesCount=0`)).news||[]).map(n=>({title:n.title,url:n.link,site:n.publisher,t:n.providerPublishTime}));
module.exports=async(req,res)=>{
  const{mode,symbol,symbols}=req.query;
  res.setHeader('Cache-Control','s-maxage=30,stale-while-revalidate=60');
  try{
    if(mode==='scan'){
      const ids=['day_gainers','most_actives','small_cap_gainers'];
      const rs=await Promise.allSettled(ids.map(id=>j(`${Y}/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&count=50&scrIds=${id}`)));
      const m={};
      rs.forEach(r=>{if(r.status==='fulfilled')(r.value.finance?.result?.[0]?.quotes||[]).forEach(q=>{if(!m[q.symbol])m[q.symbol]=q})});
      if(!Object.keys(m).length)throw new Error('Yahoo ไม่ตอบกลับ (อาจบล็อกชั่วคราว) ลองใหม่ใน 1 นาที');
      const list=Object.values(m).filter(q=>q.regularMarketPrice>=1&&(q.regularMarketVolume||0)>2e5&&/^[A-Z]{1,5}$/.test(q.symbol))
        .map(q=>({sym:q.symbol,name:q.shortName||q.longName,price:q.regularMarketPrice,chg:q.regularMarketChangePercent,
          pre:q.marketState==='PRE'&&q.preMarketChangePercent!=null?q.preMarketChangePercent:null,prePrice:q.preMarketPrice,state:q.marketState,
          vol:q.regularMarketVolume,avgVol:q.averageDailyVolume3Month,mcap:q.marketCap}))
        .sort((a,b)=>b.chg-a.chg).slice(0,25);
      await Promise.all(list.slice(0,15).map(async x=>{try{x.news=await news(x.sym)}catch(e){x.news=[]}}));
      return res.json({list});
    }
    if(mode==='news')return res.json({news:await news(symbol)});
    if(mode==='chart'){
      const r=await chart(symbol,'6mo','1d'),c=r.indicators.quote[0].close,t=r.timestamp,o={t:[],c:[]};
      c.forEach((v,i)=>{if(v!=null){o.t.push(t[i]);o.c.push(v)}});
      return res.json({...o,price:r.meta.regularMarketPrice});
    }
    if(mode==='quote'){
      const out={};
      await Promise.all((symbols||'').split(',').filter(Boolean).slice(0,30).map(async s=>{try{
        const r=await chart(s,'5d','1d'),c=r.indicators.quote[0].close.filter(v=>v!=null);
        out[s]={price:r.meta.regularMarketPrice,prev:c[c.length-2]};
      }catch(e){}}));
      return res.json({quotes:out});
    }
    if(mode==='ipo'){
      const d=new Date(),out=[],H={...UA,Referer:'https://www.nasdaq.com/',Origin:'https://www.nasdaq.com'};
      for(let i=0;i<2;i++){
        const x=new Date(d.getFullYear(),d.getMonth()+i,1),mo=x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0');
        try{
          const data=(await j('https://api.nasdaq.com/api/ipo/calendar?date='+mo,H)).data||{};
          const add=(rows,st)=>(rows||[]).forEach(r=>out.push({sym:r.proposedTickerSymbol,name:r.companyName,ex:r.proposedExchange,price:r.proposedSharePrice,shares:r.sharesOffered,date:r.expectedPriceDate||r.pricedDate||r.filedDate,status:st}));
          add(data.upcoming?.upcomingTable?.rows,'upcoming');add(data.priced?.rows,'priced');add(data.filed?.rows,'filed');
        }catch(e){}
      }
      return res.json({list:out});
    }
    res.status(400).json({error:'bad mode'});
  }catch(e){res.status(500).json({error:e.message})}
};
