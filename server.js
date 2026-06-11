const express=require('express');
const cors=require('cors');
const Groq=require('groq-sdk');
const app=express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
const groq=new Groq({apiKey:'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'});
app.post('/ask',async(req,res)=>{
const{question,component}=req.body;
try{
const completion=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',messages:[{role:'system',content:'You are VIS-7, an AI assistant for vessel inspection at Saudi Aramco CGPD. The inspector is viewing: '+component+'. Answer technically and concisely in under 100 words.'},{role:'user',content:question}]});
res.json({answer:completion.choices[0].message.content});
}catch(e){res.json({answer:'Error: '+e.message});}
});
app.listen(3000,()=>console.log('SimuSphere running on http://localhost:3000'));